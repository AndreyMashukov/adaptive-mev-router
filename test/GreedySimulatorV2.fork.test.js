const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

// TODO: This fork test references placeholder VAULT / MEV_ADDR constants. Replace with
// your deployed addresses for real fork-replay, or refactor to deploy fresh Vault + MEV
// in beforeEach via ethers.ContractFactory (see RouteSimulatorV2.test.js for the pattern).

// Mainnet addresses
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

const WETH_SLOT = 3;
const USDC_SLOT = 9;

// Pools
const V2_WETH_USDC = "0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc"; // token0=USDC, token1=WETH
const V3_WETH_USDC_03 = "0x8ad599c3A0ff1De082011EFDDc58f1908eb6e6D8"; // 0.3%, token0=USDC, token1=WETH
const V3_WETH_USDC_005 = "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640"; // 0.05%, token0=USDC, token1=WETH
const SUSHI_WETH_USDC = "0x397FF1542f962076d0BFE58eA045FfA2d347ACa0"; // SushiSwap, token0=USDC, token1=WETH

const SEL_V2 = "0x022c0d9f";
const SEL_V3 = "0x128acb08";

// PLACEHOLDER — replace with your deployed Vault address.
const VAULT = "0x000000000000000000000000000000000000000B";

// Helper: set ERC20 balance via storage manipulation
async function setTokenBalance(token, account, slot, amount) {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const storageSlot = ethers.keccak256(
    coder.encode(["address", "uint256"], [account, slot])
  );
  const value = ethers.zeroPadValue(ethers.toBeHex(amount), 32);
  await network.provider.send("hardhat_setStorageAt", [token, storageSlot, value]);
}

// Helper: set V2 pair reserves via storage slot 8
async function setV2Reserves(pair, reserve0, reserve1) {
  const pairContract = new ethers.Contract(pair, [
    "function getReserves() view returns (uint112, uint112, uint32)",
  ], ethers.provider);
  const [, , ts] = await pairContract.getReserves();
  const packed = (BigInt(ts) << 224n) | (BigInt(reserve1) << 112n) | BigInt(reserve0);
  const value = ethers.zeroPadValue(ethers.toBeHex(packed), 32);
  await network.provider.send("hardhat_setStorageAt", [pair, ethers.toBeHex(8, 32), value]);
}

function makeHop({ pool, dex, zeroForOne, tokenIn, tokenOut, feeBps = 0, tickSpacing = 0, hooks = ethers.ZeroAddress, poolId = ethers.ZeroHash, selector, idx0 = 0, idx1 = 0, to = ethers.ZeroAddress }) {
  return {
    pool, dex, zeroForOne, tokenIn, tokenOut, feeBps, tickSpacing, hooks, poolId,
    selector: selector || (dex === 0 ? SEL_V2 : SEL_V3),
    idx0, idx1, to,
  };
}

// Shared skewed setup: V3 flash → 2 identical V2 inner pools with cheap WETH
// Returns { route0, route1, flashPoolUsdcCap }
async function setupSkewedRoutes(simAddress) {
  const v2Usdc = 500_000n * 10n ** 6n;
  const v2Weth = ethers.parseEther("350"); // ~$1428/WETH (30% cheaper than V3 ~$2100)

  // Skew both V2 pools identically
  await setV2Reserves(V2_WETH_USDC, v2Usdc, v2Weth);
  await setTokenBalance(USDC, V2_WETH_USDC, USDC_SLOT, v2Usdc);
  await setTokenBalance(WETH, V2_WETH_USDC, WETH_SLOT, v2Weth);

  await setV2Reserves(SUSHI_WETH_USDC, v2Usdc, v2Weth);
  await setTokenBalance(USDC, SUSHI_WETH_USDC, USDC_SLOT, v2Usdc);
  await setTokenBalance(WETH, SUSHI_WETH_USDC, WETH_SLOT, v2Weth);

  // Cap V3 0.3% USDC: 200K → borrow 99% = 198K, chunks ~4K each = ~0.8% of V2 pool
  const flashPoolUsdcCap = 200_000n * 10n ** 6n;
  await setTokenBalance(USDC, V3_WETH_USDC_03, USDC_SLOT, flashPoolUsdcCap);

  // Fund simulator with WETH
  await setTokenBalance(WETH, simAddress, WETH_SLOT, ethers.parseEther("1000"));

  const route0 = [
    makeHop({ pool: V3_WETH_USDC_03, dex: 1, zeroForOne: false, tokenIn: WETH, tokenOut: USDC, feeBps: 3000, tickSpacing: 60 }),
    makeHop({ pool: V2_WETH_USDC, dex: 0, zeroForOne: true, tokenIn: USDC, tokenOut: WETH, feeBps: 30 }),
  ];

  const route1 = [
    makeHop({ pool: V3_WETH_USDC_03, dex: 1, zeroForOne: false, tokenIn: WETH, tokenOut: USDC, feeBps: 3000, tickSpacing: 60 }),
    makeHop({ pool: SUSHI_WETH_USDC, dex: 0, zeroForOne: true, tokenIn: USDC, tokenOut: WETH, feeBps: 30 }),
  ];

  return { route0, route1, flashPoolUsdcCap };
}

// initFactor for USDC(6dec)→WETH(18dec) at ~$1428: factor ≈ 7e26
const INIT_FACTOR = 700000000000000000000000000n;

describe("GreedySimulatorV2 — Fork Tests", function () {
  let sim;

  let _forkSnapshot;
  before(async function () {
    const code = await ethers.provider.getCode(WETH);
    if (code === "0x") {
      this.skip();
    }
    _forkSnapshot = await ethers.provider.send("evm_snapshot", []);
  });

  beforeEach(async function () {
    const GreedySimulatorV2 = await ethers.getContractFactory("GreedySimulatorV2");
    sim = await GreedySimulatorV2.deploy();
    await sim.waitForDeployment();
  });
  afterEach(async function () {
    await ethers.provider.send("evm_revert", [_forkSnapshot]);
    _forkSnapshot = await ethers.provider.send("evm_snapshot", []);
  });

  it("greedy flash: 2 routes V3 flash + V2 inner", async function () {
    const { route0, route1 } = await setupSkewedRoutes(sim.target);

    const result = await sim.simulateGreedyFlash.staticCall(
      [route0, route1], [INIT_FACTOR, INIT_FACTOR], [500n, 500n],
      30n, WETH, VAULT, 0
    );

    const greedyGas = await sim.simulateGreedyFlash.estimateGas(
      [route0, route1], [INIT_FACTOR, INIT_FACTOR], [500n, 500n],
      30n, WETH, VAULT, 0
    );
    console.log("    profit:", ethers.formatEther(result.profit), "ETH");
    console.log("    allocations:", result.allocations.map(a => ethers.formatUnits(a, 6)), "USDC");
    console.log("    greedy gas:", greedyGas.toString());
    console.log("    error:", result.error);

    expect(result.error).to.equal("", "should not have error");
    const totalAlloc = result.allocations.reduce((a, b) => a + b, 0n);
    expect(totalAlloc).to.be.gt(0n, "total allocation must be > 0");
    expect(result.finalFactors.length).to.equal(2);
    expect(result.calldata_.length).to.be.gt(2, "calldata should be non-empty");
  });

  it("greedy flash: requires >= 2 routes", async function () {
    const route0 = [
      makeHop({ pool: V3_WETH_USDC_03, dex: 1, zeroForOne: false, tokenIn: WETH, tokenOut: USDC, feeBps: 3000, tickSpacing: 60 }),
      makeHop({ pool: V2_WETH_USDC, dex: 0, zeroForOne: true, tokenIn: USDC, tokenOut: WETH, feeBps: 30 }),
    ];

    await expect(
      sim.simulateGreedyFlash.staticCall(
        [route0], [INIT_FACTOR], [500n],
        20n, WETH, VAULT, 0
      )
    ).to.be.revertedWith("routes: 2..8");
  });

  it("greedy flash: calldata contains valid MEV opcodes", async function () {
    const { route0, route1 } = await setupSkewedRoutes(sim.target);

    const result = await sim.simulateGreedyFlash.staticCall(
      [route0, route1], [INIT_FACTOR, INIT_FACTOR], [500n, 500n],
      30n, WETH, VAULT, 0
    );

    expect(result.error).to.equal("");
    expect(result.calldata_.length).to.be.gt(2, "calldata must be non-empty");

    const calldataBytes = ethers.getBytes(result.calldata_);
    const firstOpcode = calldataBytes[0];
    expect(firstOpcode).to.be.gte(0x0E, "first opcode must be a flash opcode (>= 0x0E)");
    expect(firstOpcode).to.be.lte(0x14, "first opcode must be a flash opcode (<= 0x14)");

    // Flash header: opcode(1) + selector(4) + amount(14) + pool(20) + innerLen(3) = 42 bytes
    expect(calldataBytes.length).to.be.gte(42, "calldata must contain at least flash header");

    const innerLen = (calldataBytes[39] << 16) | (calldataBytes[40] << 8) | calldataBytes[41];
    expect(innerLen).to.be.gt(0, "innerLen must be > 0");
    expect(innerLen).to.be.lt(calldataBytes.length - 42, "innerLen must be less than remaining calldata");

    console.log("    first opcode: 0x" + firstOpcode.toString(16));
    console.log("    innerLen:", innerLen, "bytes");
    console.log("    total calldata:", calldataBytes.length, "bytes");
  });

  it("greedy flash: skewed reserves — greedy strictly beats single route", async function () {
    const { route0, route1, flashPoolUsdcCap } = await setupSkewedRoutes(sim.target);

    // Greedy: split volume across both V2 pools
    const greedyResult = await sim.simulateGreedyFlash.staticCall(
      [route0, route1], [INIT_FACTOR, INIT_FACTOR], [500n, 500n],
      50n, WETH, VAULT, 0
    );

    // Single route calls — fresh RouteSimulatorV2 for each (staticCall = no state mutation)
    const RouteSim = await ethers.getContractFactory("RouteSimulatorV2");

    const routeSim0 = await RouteSim.deploy();
    await routeSim0.waitForDeployment();
    await setTokenBalance(WETH, routeSim0.target, WETH_SLOT, ethers.parseEther("1000"));
    const single0 = await routeSim0.simulateFlash.staticCall(route0, flashPoolUsdcCap, WETH, VAULT, 0);

    const routeSim1 = await RouteSim.deploy();
    await routeSim1.waitForDeployment();
    await setTokenBalance(WETH, routeSim1.target, WETH_SLOT, ethers.parseEther("1000"));
    const single1 = await routeSim1.simulateFlash.staticCall(route1, flashPoolUsdcCap, WETH, VAULT, 0);

    const bestSingleProfit = single0.profit > single1.profit ? single0.profit : single1.profit;

    console.log("    === Greedy vs Single ===");
    console.log("    greedy profit:", ethers.formatEther(greedyResult.profit), "ETH");
    console.log("    single route0:", ethers.formatEther(single0.profit), "ETH");
    console.log("    single route1:", ethers.formatEther(single1.profit), "ETH");
    console.log("    best single:  ", ethers.formatEther(bestSingleProfit), "ETH");
    console.log("    greedy allocs:", greedyResult.allocations.map(a => ethers.formatUnits(a, 6)), "USDC");
    console.log("    advantage:    ", ethers.formatEther(greedyResult.profit - bestSingleProfit), "ETH");

    expect(greedyResult.error).to.equal("", "greedy should not error");
    expect(greedyResult.profit).to.be.gt(0n, "greedy must be profitable");
    expect(greedyResult.profit).to.be.gt(bestSingleProfit, "greedy must strictly beat best single route");
    expect(greedyResult.allocations[0]).to.be.gt(0n, "route 0 must get allocation");
    expect(greedyResult.allocations[1]).to.be.gt(0n, "route 1 must get allocation");
  });

  it("greedy flash: chunks validation", async function () {
    const route0 = [
      makeHop({ pool: V3_WETH_USDC_03, dex: 1, zeroForOne: false, tokenIn: WETH, tokenOut: USDC, feeBps: 3000, tickSpacing: 60 }),
      makeHop({ pool: V2_WETH_USDC, dex: 0, zeroForOne: true, tokenIn: USDC, tokenOut: WETH, feeBps: 30 }),
    ];
    const route1 = [
      makeHop({ pool: V3_WETH_USDC_03, dex: 1, zeroForOne: false, tokenIn: WETH, tokenOut: USDC, feeBps: 3000, tickSpacing: 60 }),
      makeHop({ pool: SUSHI_WETH_USDC, dex: 0, zeroForOne: true, tokenIn: USDC, tokenOut: WETH, feeBps: 30 }),
    ];

    await expect(
      sim.simulateGreedyFlash.staticCall(
        [route0, route1], [INIT_FACTOR, INIT_FACTOR], [500n, 500n],
        3n, WETH, VAULT, 0
      )
    ).to.be.revertedWith("chunks: 5..100");
  });

  // ========== MEV contract execution: greedy → allocations → simulateFlash per route ==========

  // PLACEHOLDER — replace with your operator address.
  const OPERATOR = "0x0000000000000000000000000000000000000001";
  const OPERATOR_INDEX = 10;

  const mevContracts = [
    { name: "MEV_V2.yul",  bytecode: () => require("../artifacts/contracts/MEV_V2.yul/MEV_V2.json").bytecode, runtime: false },
    { name: "MEV_V2.huff", bytecode: () => "0x" + fs.readFileSync(path.resolve(__dirname, "..", "artifacts", "MEV_V2_huff.bin"), "utf8").trim(), runtime: true },
  ];

  async function deployMev(deployer, { bytecode, runtime }) {
    if (runtime) {
      const addr = "0x" + "dead".repeat(10);
      await ethers.provider.send("hardhat_setCode", [addr, bytecode()]);
      return addr;
    }
    const tx = await deployer.sendTransaction({ data: bytecode() });
    const receipt = await tx.wait();
    return receipt.contractAddress;
  }

  async function erc20BalanceOf(token, account) {
    const c = new ethers.Contract(token, ["function balanceOf(address) view returns (uint256)"], ethers.provider);
    return c.balanceOf(account);
  }

  // PLACEHOLDER — replace with your deployed MEV.huff address (or deploy fresh in beforeEach).
  const MEV_ADDR = "0x00000000000000000000000000000000000000FF";

  for (const contract of mevContracts) {
    it(`${contract.name}: greedy highway calldata executes in single tx`, async function () {
      this.timeout(120000);
      const snap = await ethers.provider.send("evm_snapshot", []);

      // 1. Deploy simulator at MEV_ADDR so balance_check/sweep reference same address
      const GreedySim = await ethers.getContractFactory("GreedySimulatorV2");
      const simTemp = await GreedySim.deploy();
      await simTemp.waitForDeployment();
      const simCode = await ethers.provider.getCode(simTemp.target);
      await ethers.provider.send("hardhat_setCode", [MEV_ADDR, simCode]);
      const simAtMev = await ethers.getContractAt("GreedySimulatorV2", MEV_ADDR);

      // Setup skewed reserves + fund simulator at MEV_ADDR
      const { route0, route1 } = await setupSkewedRoutes(MEV_ADDR);

      const greedyResult = await simAtMev.simulateGreedyFlash.staticCall(
        [route0, route1], [INIT_FACTOR, INIT_FACTOR], [500n, 500n],
        50n, WETH, VAULT, 0
      );
      expect(greedyResult.error).to.equal("", "greedy must not error");
      expect(greedyResult.allocations[0]).to.be.gt(0n, "route 0 must get allocation");
      expect(greedyResult.allocations[1]).to.be.gt(0n, "route 1 must get allocation");
      expect(greedyResult.profit).to.be.gt(0n, "greedy must be profitable");

      // 2. Deploy MEV contract at MEV_ADDR (replace simulator code)
      const [deployer] = await ethers.getSigners();
      if (contract.runtime) {
        await ethers.provider.send("hardhat_setCode", [MEV_ADDR, contract.bytecode()]);
      } else {
        const tx = await deployer.sendTransaction({ data: contract.bytecode() });
        const receipt = await tx.wait();
        const mevCode = await ethers.provider.getCode(receipt.contractAddress);
        await ethers.provider.send("hardhat_setCode", [MEV_ADDR, mevCode]);
      }

      // Fund MEV contract with SAME WETH balance as simulator had
      await setTokenBalance(WETH, MEV_ADDR, WETH_SLOT, ethers.parseEther("1000"));

      // 3. Execute greedy calldata through MEV contract
      await ethers.provider.send("hardhat_impersonateAccount", [OPERATOR]);
      await ethers.provider.send("hardhat_setBalance", [OPERATOR, ethers.toBeHex(ethers.parseEther("100"))]);
      const operatorSigner = await ethers.getSigner(OPERATOR);

      const wethBefore = await erc20BalanceOf(WETH, VAULT);
      const cmdLen = ethers.dataLength(greedyResult.calldata_);
      const basefee = (await ethers.provider.getBlock("latest")).baseFeePerGas;

      const mevTx = await operatorSigner.sendTransaction({
        to: MEV_ADDR,
        value: cmdLen,
        data: greedyResult.calldata_,
        gasLimit: 5000000,
        maxPriorityFeePerGas: (1000000000n & ~0xFn) | BigInt(OPERATOR_INDEX),
        maxFeePerGas: basefee * 2n + ((1000000000n & ~0xFn) | BigInt(OPERATOR_INDEX)),
      });
      const receipt = await mevTx.wait();
      expect(receipt.status).to.equal(1, "MEV tx must succeed");

      // 4. Verify WETH profit at vault
      const wethAfter = await erc20BalanceOf(WETH, VAULT);
      const wethReceived = wethAfter - wethBefore;
      expect(wethReceived).to.be.gt(0n, "vault must receive WETH profit");

      // Verify Transfer events (flash borrow + swaps + repay + profit)
      const transferIface = new ethers.Interface(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
      const transfers = receipt.logs
        .filter(l => l.address.toLowerCase() === WETH.toLowerCase())
        .map(l => { try { return transferIface.parseLog(l); } catch { return null; } })
        .filter(Boolean);
      expect(transfers.length).to.be.gte(3, "must have WETH Transfer events (repay + profit + swaps)");
      for (let i = 0; i < transfers.length; i++) {
        const t = transfers[i];
        console.log(`    Transfer[${i}]: ${t.args.from.slice(0,10)}→${t.args.to.slice(0,10)} ${ethers.formatEther(t.args.value)} WETH`);
      }

      // Sweep transfer sends profit to vault
      const vaultTransfers = transfers.filter(t => t.args.to.toLowerCase() === VAULT.toLowerCase());
      expect(vaultTransfers.length).to.be.gte(1, "must have at least one WETH transfer to vault");
      const sweepAmount = vaultTransfers.reduce((sum, t) => sum + t.args.value, 0n);
      expect(sweepAmount).to.be.gt(0n, "vault must receive WETH profit");
      console.log(`    vault received: ${ethers.formatEther(sweepAmount)} WETH`);

      console.log(`    ${contract.name}: MEV profit=${ethers.formatEther(wethReceived)} ETH, gas=${receipt.gasUsed}`);
      console.log(`    greedy simulated: ${ethers.formatEther(greedyResult.profit)} ETH`);
      console.log(`    calldata: ${cmdLen} bytes, allocs: ${greedyResult.allocations.map(a => ethers.formatUnits(a, 6))} USDC`);

      await ethers.provider.send("evm_revert", [snap]);
    });
  }

  // ========== Mixed-length chains: 2/3/4-hop routes in a single greedy call ==========

  const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
  const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
  const DAI_SLOT = 2;
  const USDT_SLOT = 2;

  // 3-hop pools
  const V2_USDC_DAI = "0xAE461cA67B15dc8dc81CE7615e0320dA1A9aB8D5";   // t0=DAI, t1=USDC
  const V2_DAI_WETH = "0xA478c2975Ab1Ea89e8196811F51A7B7Ade33eB11";   // t0=DAI, t1=WETH
  const SUSHI_DAI_USDC = "0xAaF5110db6e744ff70fB339DE037B990A20bdace"; // t0=DAI, t1=USDC
  const SUSHI_DAI_WETH = "0xC3D03e4F041Fd4cD388c549Ee2A29a9E5075882f"; // t0=DAI, t1=WETH

  // 4-hop pools
  const V2_USDC_USDT = "0x3041CbD36888bECc7bbCBc0045E3B1f144466f5f"; // t0=USDC, t1=USDT
  const V2_FACTORY = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f";

  async function getV2Pair(factory, tokenA, tokenB) {
    const f = new ethers.Contract(factory, ["function getPair(address,address) view returns (address)"], ethers.provider);
    return f.getPair(tokenA, tokenB);
  }

  async function poolHasCode(addr) {
    const code = await ethers.provider.getCode(addr);
    return code !== "0x";
  }

  // USDC(6dec)→DAI(18dec) factor: ~1e30 (1 USDC = ~1 DAI, but 12 decimal shift)
  const INIT_FACTOR_USDC_DAI = 1000000000000000000000000000000n; // 1e30

  it("greedy flash: mixed-length chains (2/3/4 hops)", async function () {
    this.timeout(120000);

    // Verify all required pools exist
    const poolChecks = await Promise.all([
      poolHasCode(V2_USDC_DAI), poolHasCode(V2_DAI_WETH),
      poolHasCode(SUSHI_DAI_USDC), poolHasCode(SUSHI_DAI_WETH),
      poolHasCode(V2_USDC_USDT),
    ]);
    expect(poolChecks.every(Boolean)).to.equal(true, "required pools must have code");

    // Find V2 DAI/USDT pair dynamically from factory
    const v2DaiUsdt = await getV2Pair(V2_FACTORY, DAI, USDT);
    const has4hop = v2DaiUsdt !== ethers.ZeroAddress && await poolHasCode(v2DaiUsdt);

    // --- Skew reserves ---
    // V2 direct pools: WETH cheap (~$1428 vs V3 ~$2100)
    const v2Usdc = 500_000n * 10n ** 6n;
    const v2Weth = ethers.parseEther("350");

    await setV2Reserves(V2_WETH_USDC, v2Usdc, v2Weth);
    await setTokenBalance(USDC, V2_WETH_USDC, USDC_SLOT, v2Usdc);
    await setTokenBalance(WETH, V2_WETH_USDC, WETH_SLOT, v2Weth);

    await setV2Reserves(SUSHI_WETH_USDC, v2Usdc, v2Weth);
    await setTokenBalance(USDC, SUSHI_WETH_USDC, USDC_SLOT, v2Usdc);
    await setTokenBalance(WETH, SUSHI_WETH_USDC, WETH_SLOT, v2Weth);

    // 3-hop pools: ~1:1 stablecoin peg for USDC/DAI, then DAI→WETH cheap
    const daiAmt = ethers.parseEther("500000");  // 500K DAI (18dec)
    const usdcAmt = 500_000n * 10n ** 6n;        // 500K USDC (6dec)

    // V2_USDC_DAI: t0=DAI, t1=USDC → reserve0=DAI, reserve1=USDC
    await setV2Reserves(V2_USDC_DAI, daiAmt, usdcAmt);
    await setTokenBalance(DAI, V2_USDC_DAI, DAI_SLOT, daiAmt);
    await setTokenBalance(USDC, V2_USDC_DAI, USDC_SLOT, usdcAmt);

    // SUSHI_DAI_USDC: t0=DAI, t1=USDC
    await setV2Reserves(SUSHI_DAI_USDC, daiAmt, usdcAmt);
    await setTokenBalance(DAI, SUSHI_DAI_USDC, DAI_SLOT, daiAmt);
    await setTokenBalance(USDC, SUSHI_DAI_USDC, USDC_SLOT, usdcAmt);

    // V2_DAI_WETH: t0=DAI, t1=WETH — DAI cheap relative to WETH
    const daiWethDai = ethers.parseEther("700000"); // 700K DAI
    const daiWethWeth = ethers.parseEther("350");    // 350 WETH (~$2000/ETH with DAI)
    await setV2Reserves(V2_DAI_WETH, daiWethDai, daiWethWeth);
    await setTokenBalance(DAI, V2_DAI_WETH, DAI_SLOT, daiWethDai);
    await setTokenBalance(WETH, V2_DAI_WETH, WETH_SLOT, daiWethWeth);

    // SUSHI_DAI_WETH: t0=DAI, t1=WETH
    await setV2Reserves(SUSHI_DAI_WETH, daiWethDai, daiWethWeth);
    await setTokenBalance(DAI, SUSHI_DAI_WETH, DAI_SLOT, daiWethDai);
    await setTokenBalance(WETH, SUSHI_DAI_WETH, WETH_SLOT, daiWethWeth);

    // 4-hop pools (if available)
    if (has4hop) {
      // V2_USDC_USDT: t0=USDC, t1=USDT — 1:1 peg
      const usdtAmt = 500_000n * 10n ** 6n;
      await setV2Reserves(V2_USDC_USDT, usdcAmt, usdtAmt);
      await setTokenBalance(USDC, V2_USDC_USDT, USDC_SLOT, usdcAmt);
      await setTokenBalance(USDT, V2_USDC_USDT, USDT_SLOT, usdtAmt);

      // V2_DAI_USDT: t0=DAI (or USDT, depends on sort). Set reserves.
      const t0DaiUsdt = DAI.toLowerCase() < USDT.toLowerCase() ? DAI : USDT;
      const isDaiToken0 = t0DaiUsdt.toLowerCase() === DAI.toLowerCase();
      const r0 = isDaiToken0 ? daiAmt : 500_000n * 10n ** 6n;
      const r1 = isDaiToken0 ? 500_000n * 10n ** 6n : daiAmt;
      await setV2Reserves(v2DaiUsdt, r0, r1);
      await setTokenBalance(DAI, v2DaiUsdt, DAI_SLOT, daiAmt);
      await setTokenBalance(USDT, v2DaiUsdt, USDT_SLOT, 500_000n * 10n ** 6n);
    }

    // Cap V3 flash pool USDC
    const flashPoolUsdcCap = 200_000n * 10n ** 6n;
    await setTokenBalance(USDC, V3_WETH_USDC_03, USDC_SLOT, flashPoolUsdcCap);

    // Fund simulator
    await setTokenBalance(WETH, sim.target, WETH_SLOT, ethers.parseEther("1000"));

    // --- Build routes ---
    const flashHop = makeHop({ pool: V3_WETH_USDC_03, dex: 1, zeroForOne: false, tokenIn: WETH, tokenOut: USDC, feeBps: 3000, tickSpacing: 60 });

    // Route 0: 2-hop — flash → V2 USDC→WETH
    const route0 = [flashHop, makeHop({ pool: V2_WETH_USDC, dex: 0, zeroForOne: true, tokenIn: USDC, tokenOut: WETH, feeBps: 30 })];
    // Route 1: 2-hop — flash → Sushi USDC→WETH
    const route1 = [flashHop, makeHop({ pool: SUSHI_WETH_USDC, dex: 0, zeroForOne: true, tokenIn: USDC, tokenOut: WETH, feeBps: 30 })];
    // Route 2: 3-hop — flash → V2 USDC→DAI → V2 DAI→WETH
    // V2_USDC_DAI: t0=DAI,t1=USDC → USDC→DAI = zeroForOne=false (sell t1, buy t0)
    const route2 = [
      flashHop,
      makeHop({ pool: V2_USDC_DAI, dex: 0, zeroForOne: false, tokenIn: USDC, tokenOut: DAI, feeBps: 30 }),
      makeHop({ pool: V2_DAI_WETH, dex: 0, zeroForOne: true, tokenIn: DAI, tokenOut: WETH, feeBps: 30 }),
    ];
    // Route 3: 3-hop — flash → Sushi USDC→DAI → Sushi DAI→WETH
    const route3 = [
      flashHop,
      makeHop({ pool: SUSHI_DAI_USDC, dex: 0, zeroForOne: false, tokenIn: USDC, tokenOut: DAI, feeBps: 30 }),
      makeHop({ pool: SUSHI_DAI_WETH, dex: 0, zeroForOne: true, tokenIn: DAI, tokenOut: WETH, feeBps: 30 }),
    ];

    let routes, factors, losses;
    if (has4hop) {
      // Route 4: 4-hop — flash → V2 USDC→USDT → V2 USDT→DAI → V2 DAI→WETH
      // V2_USDC_USDT: t0=USDC,t1=USDT → USDC→USDT = zeroForOne=true
      // V2_DAI_USDT: t0=DAI,t1=USDT (DAI<USDT) → USDT→DAI = zeroForOne=false
      const route4 = [
        flashHop,
        makeHop({ pool: V2_USDC_USDT, dex: 0, zeroForOne: true, tokenIn: USDC, tokenOut: USDT, feeBps: 30 }),
        makeHop({ pool: v2DaiUsdt, dex: 0, zeroForOne: false, tokenIn: USDT, tokenOut: DAI, feeBps: 30 }),
        makeHop({ pool: V2_DAI_WETH, dex: 0, zeroForOne: true, tokenIn: DAI, tokenOut: WETH, feeBps: 30 }),
      ];
      routes = [route0, route1, route2, route3, route4];
      factors = [INIT_FACTOR, INIT_FACTOR, INIT_FACTOR, INIT_FACTOR, INIT_FACTOR];
      losses = [500n, 500n, 500n, 500n, 500n];
      console.log("    using 5 routes: 2×2-hop + 2×3-hop + 1×4-hop");
    } else {
      routes = [route0, route1, route2, route3];
      factors = [INIT_FACTOR, INIT_FACTOR, INIT_FACTOR, INIT_FACTOR];
      losses = [500n, 500n, 500n, 500n];
      console.log("    V2 DAI/USDT pair not found, using 4 routes: 2×2-hop + 2×3-hop");
    }

    const result = await sim.simulateGreedyFlash.staticCall(
      routes, factors, losses, 30n, WETH, VAULT, 0
    );

    // --- Assertions ---
    expect(result.error).to.equal("", "should not have error");
    expect(result.profit).to.be.gt(0n, "must be profitable");
    expect(result.allocations.length).to.equal(routes.length, "allocations count must match routes");
    expect(result.calldata_.length).to.be.gt(2, "calldata must be non-empty");

    // At least 2 routes must get allocation
    const nonZeroAllocs = result.allocations.filter(a => a > 0n).length;
    expect(nonZeroAllocs).to.be.gte(2, "at least 2 routes must get non-zero allocation");

    // First opcode must be flash
    const calldataBytes = ethers.getBytes(result.calldata_);
    expect(calldataBytes[0]).to.be.gte(0x0E, "first opcode must be flash (>= 0x0E)");
    expect(calldataBytes[0]).to.be.lte(0x14, "first opcode must be flash (<= 0x14)");

    // Log results with hop counts
    const hopCounts = routes.map(r => r.length);
    for (let i = 0; i < routes.length; i++) {
      console.log(`    route[${i}] ${hopCounts[i]}-hop: alloc=${ethers.formatUnits(result.allocations[i], 6)} USDC, factor=${result.finalFactors[i]}`);
    }
    console.log("    total profit:", ethers.formatEther(result.profit), "ETH");
    console.log("    calldata:", calldataBytes.length, "bytes");
    console.log("    non-zero allocations:", nonZeroAllocs, "of", routes.length);
  });

  // ========== BUG REPRO: one bad route kills entire combo ==========

  it("greedy flash: one reverting route kills entire combo (BUG)", async function () {
    this.timeout(120000);

    const { route0, route1 } = await setupSkewedRoutes(sim.target);

    // Drain Sushi pool completely — route1 will revert on swap
    await setV2Reserves(SUSHI_WETH_USDC, 0n, 0n);
    await setTokenBalance(USDC, SUSHI_WETH_USDC, USDC_SLOT, 0n);
    await setTokenBalance(WETH, SUSHI_WETH_USDC, WETH_SLOT, 0n);

    // route0 is fine (V2_WETH_USDC has liquidity), route1 is dead (Sushi drained)
    // Currently: entire combo reverts because _greedyIteration has no try-catch
    const result = await sim.simulateGreedyFlash.staticCall(
      [route0, route1], [INIT_FACTOR, INIT_FACTOR], [500n, 500n],
      30n, WETH, VAULT, 0
    );

    console.log("    error:", result.error);
    console.log("    profit:", ethers.formatEther(result.profit), "ETH");
    console.log("    allocations:", result.allocations.map(a => ethers.formatUnits(a, 6)), "USDC");

    // BUG: this currently fails — error is non-empty because route1 reverts
    // and takes down the whole combo. After fix: should skip route1, profit from route0 only.
    expect(result.error).to.equal("", "should survive one bad route");
    expect(result.profit).to.be.gt(0n, "must be profitable from the good route");
    expect(result.allocations[0]).to.be.gt(0n, "good route must get allocation");
    expect(result.allocations[1]).to.equal(0n, "dead route must get zero allocation");
  });

  it("greedy flash: all routes revert — returns GREEDY REPAY error", async function () {
    this.timeout(120000);

    const { route0, route1 } = await setupSkewedRoutes(sim.target);

    // Drain BOTH pools — all routes will revert
    await setV2Reserves(V2_WETH_USDC, 0n, 0n);
    await setTokenBalance(USDC, V2_WETH_USDC, USDC_SLOT, 0n);
    await setTokenBalance(WETH, V2_WETH_USDC, WETH_SLOT, 0n);

    await setV2Reserves(SUSHI_WETH_USDC, 0n, 0n);
    await setTokenBalance(USDC, SUSHI_WETH_USDC, USDC_SLOT, 0n);
    await setTokenBalance(WETH, SUSHI_WETH_USDC, WETH_SLOT, 0n);

    const result = await sim.simulateGreedyFlash.staticCall(
      [route0, route1], [INIT_FACTOR, INIT_FACTOR], [500n, 500n],
      30n, WETH, VAULT, 0
    );

    console.log("    error:", result.error);
    console.log("    profit:", ethers.formatEther(result.profit), "ETH");

    // Both routes dead — profit must be zero (error may or may not be set
    // depending on whether flash repay check fires before V3 pool reverts)
    expect(result.profit).to.equal(0n, "no profit when all routes dead");
    console.log("    all-dead outcome: error=%s, profit=%s", result.error || "(none)", result.profit);
  });

  it("greedy flash: 3 routes, 2 bad — profits from single survivor", async function () {
    this.timeout(120000);

    const v2Usdc = 500_000n * 10n ** 6n;
    const v2Weth = ethers.parseEther("350");

    // Only V2_WETH_USDC has liquidity
    await setV2Reserves(V2_WETH_USDC, v2Usdc, v2Weth);
    await setTokenBalance(USDC, V2_WETH_USDC, USDC_SLOT, v2Usdc);
    await setTokenBalance(WETH, V2_WETH_USDC, WETH_SLOT, v2Weth);

    // Drain Sushi
    await setV2Reserves(SUSHI_WETH_USDC, 0n, 0n);
    await setTokenBalance(USDC, SUSHI_WETH_USDC, USDC_SLOT, 0n);
    await setTokenBalance(WETH, SUSHI_WETH_USDC, WETH_SLOT, 0n);

    // Cap flash pool
    const flashPoolUsdcCap = 200_000n * 10n ** 6n;
    await setTokenBalance(USDC, V3_WETH_USDC_03, USDC_SLOT, flashPoolUsdcCap);
    await setTokenBalance(WETH, sim.target, WETH_SLOT, ethers.parseEther("1000"));

    const flashHop = makeHop({ pool: V3_WETH_USDC_03, dex: 1, zeroForOne: false, tokenIn: WETH, tokenOut: USDC, feeBps: 3000, tickSpacing: 60 });
    const route0 = [flashHop, makeHop({ pool: V2_WETH_USDC, dex: 0, zeroForOne: true, tokenIn: USDC, tokenOut: WETH, feeBps: 30 })];
    const route1 = [flashHop, makeHop({ pool: SUSHI_WETH_USDC, dex: 0, zeroForOne: true, tokenIn: USDC, tokenOut: WETH, feeBps: 30 })];
    // route2 = duplicate of route1 (also dead)
    const route2 = [flashHop, makeHop({ pool: SUSHI_WETH_USDC, dex: 0, zeroForOne: true, tokenIn: USDC, tokenOut: WETH, feeBps: 30 })];

    const result = await sim.simulateGreedyFlash.staticCall(
      [route0, route1, route2],
      [INIT_FACTOR, INIT_FACTOR, INIT_FACTOR],
      [500n, 500n, 500n],
      30n, WETH, VAULT, 0
    );

    console.log("    error:", result.error);
    console.log("    profit:", ethers.formatEther(result.profit), "ETH");
    console.log("    allocations:", result.allocations.map(a => ethers.formatUnits(a, 6)), "USDC");

    expect(result.error).to.equal("", "should survive 2 bad routes");
    expect(result.profit).to.be.gt(0n, "must be profitable from survivor");
    expect(result.allocations[0]).to.be.gt(0n, "route 0 (good) gets all volume");
    expect(result.allocations[1]).to.equal(0n, "route 1 (dead) gets zero");
    expect(result.allocations[2]).to.equal(0n, "route 2 (dead) gets zero");
  });
});
