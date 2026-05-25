const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

// Mainnet tokens
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";

const V4_PM = "0x000000000004444c5dc75cB358380D2e3dE08A90";

// V2 pair: token0=USDC, token1=WETH
const V2_USDC_WETH  = "0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc";

// TODO: PLACEHOLDER constants. For real fork-replay, replace with your deployed addresses
// OR refactor to deploy fresh in beforeEach via ContractFactory (see RouteSimulatorV2.test.js).
const OPERATOR_ADDRESS = "0x0000000000000000000000000000000000000001";
const OPERATOR_INDEX = 0;
const VAULT = "0x000000000000000000000000000000000000000B";
const MEV_ADDRESS = "0x00000000000000000000000000000000000000FF";

const WETH_SLOT = 3;
const USDC_SLOT = 9;

const SEL_V2 = "0x022c0d9f";

function wrapRuntimeBytecode(runtimeHex) {
  const runtime = runtimeHex.startsWith("0x") ? runtimeHex.slice(2) : runtimeHex;
  return "0x600b380380600b5f395ff3" + runtime;
}

function loadVariants() {
  const MEVJson = require("../artifacts/contracts/MEV_V2.yul/MEV_V2.json");
  const huffBinPath = path.join(__dirname, "..", "artifacts", "MEV_V2_huff.bin");
  if (!fs.existsSync(huffBinPath)) {
    throw new Error(
      `Huff runtime bytecode not found at ${huffBinPath}. ` +
      `Install huffc and run: huffc contracts/MEV_V2.huff -r > artifacts/MEV_V2_huff.bin`
    );
  }
  const huffRuntime = fs.readFileSync(huffBinPath, "utf8").trim();
  return [
    { name: "Yul",  abi: MEVJson.abi, bytecode: MEVJson.bytecode },
    { name: "Huff", abi: MEVJson.abi, bytecode: wrapRuntimeBytecode(huffRuntime) },
  ];
}

async function setTokenBalance(token, account, slot, amount) {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const storageSlot = ethers.keccak256(
    coder.encode(["address", "uint256"], [account, slot])
  );
  await network.provider.send("hardhat_setStorageAt", [
    token, storageSlot, ethers.zeroPadValue(ethers.toBeHex(amount), 32),
  ]);
}

async function setV2Reserves(pair, reserve0, reserve1) {
  const pairContract = new ethers.Contract(pair, [
    "function getReserves() view returns (uint112, uint112, uint32)",
  ], ethers.provider);
  const [, , ts] = await pairContract.getReserves();
  const packed = (BigInt(ts) << 224n) | (BigInt(reserve1) << 112n) | BigInt(reserve0);
  await network.provider.send("hardhat_setStorageAt", [
    pair, ethers.toBeHex(8, 32), ethers.zeroPadValue(ethers.toBeHex(packed), 32),
  ]);
}

const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

function parseTransfers(receipt) {
  return receipt.logs
    .filter(l => l.topics[0] === TRANSFER_TOPIC)
    .map(l => ({
      from: "0x" + l.topics[1].slice(26),
      to: "0x" + l.topics[2].slice(26),
      value: BigInt(l.data),
      token: l.address.toLowerCase(),
    }));
}

function makeHop(overrides) {
  const dex = overrides.dex ?? 0;
  const defaultSel = dex === 0 ? SEL_V2 : "0x00000000";
  return {
    pool: overrides.pool || ethers.ZeroAddress,
    dex,
    zeroForOne: overrides.zeroForOne ?? true,
    tokenIn: overrides.tokenIn || ethers.ZeroAddress,
    tokenOut: overrides.tokenOut || ethers.ZeroAddress,
    feeBps: overrides.feeBps ?? 0,
    tickSpacing: overrides.tickSpacing ?? 0,
    hooks: overrides.hooks || ethers.ZeroAddress,
    poolId: overrides.poolId || ethers.ZeroHash,
    selector: overrides.selector || defaultSel,
    idx0: overrides.idx0 ?? 0,
    idx1: overrides.idx1 ?? 0,
    to: overrides.to || ethers.ZeroAddress,
  };
}

/**
 * V4-inside-flash nested callback regression test.
 *
 * Minimal 2-hop chain that triggers nested callbacks:
 *   V2 flash (USDT/WETH) borrow USDT → V4 (USDT→ETH) → wrap_weth → repay WETH
 *
 * Skew V2 pair: make USDT very cheap (lots of USDT, little WETH).
 * Borrow cheap USDT → swap to ETH on V4 at market price → profit.
 *
 * Callback nesting:
 *   MEV call → V2.swap() → V2 callback → dispatch_loop → V4_UNLOCK → PM.unlock() → unlockCallback → dispatch_loop → return → continue V2 dispatch
 */
describe("MEV_V2 V4-inside-flash — Fork Test", function () {
  let owner, operator;
  let _forkSnapshot;

  before(async function () {
    const code = await ethers.provider.getCode(WETH);
    if (code === "0x") this.skip();
    _forkSnapshot = await ethers.provider.send("evm_snapshot", []);

    [owner] = await ethers.getSigners();
    await ethers.provider.send("hardhat_impersonateAccount", [OPERATOR_ADDRESS]);
    operator = await ethers.getSigner(OPERATOR_ADDRESS);
    await owner.sendTransaction({ to: OPERATOR_ADDRESS, value: ethers.parseEther("100") });
  });

  after(async function () {
    if (_forkSnapshot) await ethers.provider.send("evm_revert", [_forkSnapshot]);
  });

  async function skewAndGenerate() {
    // Deploy RouteSimulatorV2 at MEV_ADDRESS
    const Sim = await ethers.getContractFactory("RouteSimulatorV2");
    const simTemp = await Sim.deploy();
    await simTemp.waitForDeployment();
    const simCode = await ethers.provider.getCode(simTemp.target);
    await ethers.provider.send("hardhat_setCode", [MEV_ADDRESS, simCode]);
    const sim = await ethers.getContractAt("RouteSimulatorV2", MEV_ADDRESS);

    // Fund with WETH for flash repay
    await setTokenBalance(WETH, MEV_ADDRESS, WETH_SLOT, ethers.parseEther("1000"));

    // Skew V2 USDC/WETH: make USDC expensive on V2 (little USDC, lots of WETH)
    // V4 ETH/USDC: ~$2000/ETH = 2000 USDC per ETH (market)
    // V2 USDC/WETH: 100k USDC / 5000 WETH = 20 USDC per WETH ($20/ETH)
    // → borrow USDC from V2 (costs very little WETH to repay)
    // → sell USDC for ETH on V4 at $2000/ETH → much more WETH than needed → profit
    const usdcReserve = 100_000n * 10n ** 6n;       // 100k USDC (little)
    const wethReserve = ethers.parseEther("5000");   // 5000 WETH (lots) → 20 USDC/WETH
    await setV2Reserves(V2_USDC_WETH, usdcReserve, wethReserve);
    await setTokenBalance(USDC, V2_USDC_WETH, USDC_SLOT, usdcReserve);
    await setTokenBalance(WETH, V2_USDC_WETH, WETH_SLOT, wethReserve);

    // Route: V2 flash borrow USDC → V4 USDC→ETH
    // V2 pair: token0=USDC, token1=WETH
    // In executeFlash: zeroForOne=false → a0=borrow (token0=USDC)
    // We want to borrow USDC (token0) → zeroForOne=false
    const route = [
      makeHop({
        pool: V2_USDC_WETH, dex: 0, zeroForOne: false,
        tokenIn: WETH, tokenOut: USDC, feeBps: 30, selector: SEL_V2,
      }),
      makeHop({
        pool: V4_PM, dex: 2, zeroForOne: false,
        tokenIn: USDC, tokenOut: ethers.ZeroAddress,
        feeBps: 500, tickSpacing: 10, selector: "0x48c89491",
      }),
    ];

    const borrowAmount = 1_000n * 10n ** 6n; // 1k USDC

    const result = await sim.simulateFlash.staticCall(route, borrowAmount, WETH, VAULT, 0);
    const cd = result[1];
    // Strip balance_check (55 bytes) + sweep (41 bytes) from end
    // These are outer commands after the flash, they check profitability
    // We want to test the flash+V4 dispatch, not profitability
    const strippedLen = (cd.length - 2) / 2 - 55 - 41; // bytes without balance_check + sweep
    const stripped = cd.slice(0, 2 + strippedLen * 2);
    return { calldata: stripped, profit: result[0], fullCalldata: cd };
  }

  // --- Standalone V4 test (isolates resolve_amount from nested dispatch) ---
  loadVariants().forEach((variant) => {
    it(`MEV_V2 [${variant.name}]: V4 standalone with amount=0`, async function () {
      const snap = await ethers.provider.send("evm_snapshot", []);
      try {
        // Deploy RouteSimulatorV2 to generate V4 calldata with amount=0
        const Sim = await ethers.getContractFactory("RouteSimulatorV2");
        const simTemp = await Sim.deploy();
        await simTemp.waitForDeployment();

        // Fund sim with USDC
        await setTokenBalance(USDC, simTemp.target, USDC_SLOT, 1000n * 10n ** 6n);

        // V4 swap USDC→ETH with resolveAll=true (amounts=0 in calldata)
        const hop = makeHop({
          pool: V4_PM, dex: 2, zeroForOne: false,
          tokenIn: USDC, tokenOut: ethers.ZeroAddress,
          feeBps: 500, tickSpacing: 10, selector: "0x48c89491",
        });

        // simulateResolveAll packs amount=0 for intermediate hops
        const result = await simTemp.simulateResolveAll.staticCall([hop], 1000n * 10n ** 6n);
        const cd = result[1];
        console.log(`    [${variant.name}] V4 standalone calldata: ${(cd.length-2)/2} bytes`);

        // Deploy MEV variant at MEV_ADDRESS
        const MEVFactory = new ethers.ContractFactory(variant.abi, variant.bytecode, owner);
        const mevTemp = await MEVFactory.deploy();
        await mevTemp.waitForDeployment();
        const mevCode = await ethers.provider.getCode(mevTemp.target);
        await ethers.provider.send("hardhat_setCode", [MEV_ADDRESS, mevCode]);

        // Fund with USDC (for V4 settle) and ETH
        await setTokenBalance(USDC, MEV_ADDRESS, USDC_SLOT, 1000n * 10n ** 6n);
        await owner.sendTransaction({ to: MEV_ADDRESS, value: ethers.parseEther("10") });

        // Execute
        const block = await ethers.provider.getBlock("latest");
        const baseFee = block.baseFeePerGas || 1000000000n;
        const priorityFee = (1000000000n & ~0xFn) | BigInt(OPERATOR_INDEX);

        const resp = await operator.sendTransaction({
          to: MEV_ADDRESS,
          data: cd,
          value: BigInt((cd.length - 2) / 2),
          maxPriorityFeePerGas: priorityFee,
          maxFeePerGas: baseFee * 2n + priorityFee,
          gasLimit: 5000000n,
        });
        const receipt = await resp.wait();

        console.log(`    [${variant.name}] V4 standalone gas: ${receipt.gasUsed}`);
        expect(receipt.status).to.equal(1);

        // Parse and verify Transfer events
        const transfers = parseTransfers(receipt);
        console.log(`    [${variant.name}] transfers: ${transfers.length}`);
        transfers.forEach((t, i) => console.log(`      #${i}: ${t.token} ${t.from} → ${t.to} value=${t.value}`));

        // V4 settle: USDC transferred from MEV_ADDRESS → V4 PoolManager
        const settleXfer = transfers.find(
          t => t.token === USDC.toLowerCase() &&
               t.from === MEV_ADDRESS.toLowerCase() &&
               t.to === V4_PM.toLowerCase()
        );
        expect(settleXfer, "must have USDC settle transfer: MEV→PM").to.exist;
        expect(settleXfer.value).to.be.gt(0n, "settle amount must be > 0");

        // V4 take delivers native ETH — no Transfer event for native ETH
        // Only 1 ERC20 Transfer expected (USDC settle)
      } finally {
        await ethers.provider.send("evm_revert", [snap]);
      }
    });
  });

  // --- V4-inside-flash test ---
  loadVariants().forEach((variant) => {
    it(`MEV_V2 [${variant.name}]: V4-inside-V2-flash executes`, async function () {
      const snap = await ethers.provider.send("evm_snapshot", []);
      try {
        const { calldata: cd, profit, fullCalldata } = await skewAndGenerate();
        console.log(`    [${variant.name}] sim profit: ${ethers.formatEther(profit)} ETH`);
        console.log(`    [${variant.name}] calldata: ${(cd.length-2)/2} bytes`);

        // Verify V4 unlock present
        const hasV4 = cd.toLowerCase().includes("14000000000004444c");
        console.log(`    [${variant.name}] has V4 unlock: ${hasV4}`);
        console.log(`    [${variant.name}] calldata hex: ${cd}`);
        expect(hasV4, "calldata must contain V4 unlock opcode").to.be.true;

        // Set MEV variant code at MEV_ADDRESS
        const MEVFactory = new ethers.ContractFactory(variant.abi, variant.bytecode, owner);
        const mevTemp = await MEVFactory.deploy();
        await mevTemp.waitForDeployment();
        const mevCode = await ethers.provider.getCode(mevTemp.target);
        await ethers.provider.send("hardhat_setCode", [MEV_ADDRESS, mevCode]);

        // Fund with SAME WETH balance that simulator had (calldata has balance_check referencing it)
        await setTokenBalance(WETH, MEV_ADDRESS, WETH_SLOT, ethers.parseEther("1000"));
        await owner.sendTransaction({ to: MEV_ADDRESS, value: ethers.parseEther("10") });

        // Execute
        const block = await ethers.provider.getBlock("latest");
        const baseFee = block.baseFeePerGas || 1000000000n;
        const priorityFee = (1000000000n & ~0xFn) | BigInt(OPERATOR_INDEX);

        const resp = await operator.sendTransaction({
          to: MEV_ADDRESS,
          data: cd,
          value: BigInt((cd.length - 2) / 2),
          maxPriorityFeePerGas: priorityFee,
          maxFeePerGas: baseFee * 2n + priorityFee,
          gasLimit: 5000000n,
        });
        const receipt = await resp.wait();

        console.log(`    [${variant.name}] gas: ${receipt.gasUsed}`);
        expect(receipt.status).to.equal(1, `${variant.name} must succeed`);

        const transfers = parseTransfers(receipt);
        console.log(`    [${variant.name}] transfers: ${transfers.length}`);
        transfers.forEach((t, i) => console.log(`      #${i}: ${t.token} ${t.from} → ${t.to} value=${t.value}`));
        expect(transfers.length).to.be.gte(3, "must have flash borrow + V4 settle + flash repay transfers");

        // Transfer 1: V2 flash borrow — USDC from V2_PAIR → MEV_ADDRESS
        const borrowXfer = transfers.find(
          t => t.token === USDC.toLowerCase() &&
               t.from === V2_USDC_WETH.toLowerCase() &&
               t.to === MEV_ADDRESS.toLowerCase()
        );
        expect(borrowXfer, "must have USDC borrow transfer: V2Pair→MEV").to.exist;
        expect(borrowXfer.value).to.be.gt(0n, "borrow amount must be > 0");

        // Transfer 2: V4 settle — USDC from MEV_ADDRESS → V4 PoolManager
        const settleXfer = transfers.find(
          t => t.token === USDC.toLowerCase() &&
               t.from === MEV_ADDRESS.toLowerCase() &&
               t.to === V4_PM.toLowerCase()
        );
        expect(settleXfer, "must have USDC settle transfer: MEV→PM").to.exist;
        expect(settleXfer.value).to.be.gt(0n, "settle amount must be > 0");
        // Settle amount should match borrow amount (same USDC flows through)
        expect(settleXfer.value).to.equal(borrowXfer.value, "settle amount must equal borrow amount");

        // Transfer 3: V2 flash repay — WETH from MEV_ADDRESS → V2_PAIR
        const repayXfer = transfers.find(
          t => t.token === WETH.toLowerCase() &&
               t.from === MEV_ADDRESS.toLowerCase() &&
               t.to === V2_USDC_WETH.toLowerCase()
        );
        expect(repayXfer, "must have WETH repay transfer: MEV→V2Pair").to.exist;
        expect(repayXfer.value).to.be.gt(0n, "repay amount must be > 0");
      } finally {
        await ethers.provider.send("evm_revert", [snap]);
      }
    });
  });
});
