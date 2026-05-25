const { expect } = require("chai");
const { ethers } = require("hardhat");

// Addresses
const WETH_ADDRESS = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const OPERATOR_ADDRESS = "0x0000000000000000000000000000000000000001";
const OPERATOR_INDEX = 0;

// Event topic hashes
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

// V3 pool address computation (CREATE2)
const UNI_V3_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const POOL_INIT_CODE_HASH = "0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54";

// Selectors
const SEL_V2 = "0x022c0d9f"; // swap(uint256,uint256,address,bytes)
const SEL_V3 = "0x128acb08"; // swap(address,bool,int256,uint160,bytes)

function buildHop(overrides) {
  const dex = overrides.dex ?? 0;
  const defaultSel = dex === 0 ? SEL_V2 : dex === 1 ? SEL_V3 : "0x00000000";
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

// Wrap runtime bytecode in minimal deployer
function wrapRuntimeBytecode(runtimeHex) {
  const runtime = runtimeHex.startsWith("0x") ? runtimeHex.slice(2) : runtimeHex;
  const initCode = "600b380380600b5f395ff3";
  return "0x" + initCode + runtime;
}

// Load MEV_V2 variants (Yul + Huff)
function loadVariants() {
  const fs = require("fs");
  const path = require("path");
  const MEVJson = require("../artifacts/contracts/MEV_V2.yul/MEV_V2.json");
  const variants = [{ name: "Yul", abi: MEVJson.abi, bytecode: MEVJson.bytecode }];
  const huffBinPath = path.join(__dirname, "..", "artifacts", "MEV_V2_huff.bin");
  if (fs.existsSync(huffBinPath)) {
    const huffRuntime = fs.readFileSync(huffBinPath, "utf8").trim();
    variants.push({ name: "Huff", abi: MEVJson.abi, bytecode: wrapRuntimeBytecode(huffRuntime) });
  }
  return variants;
}

async function sendAndLog(signer, tx, label) {
  if (tx.maxPriorityFeePerGas === undefined) {
    const block = await ethers.provider.getBlock("latest");
    const baseFee = block.baseFeePerGas || 1000000000n;
    const priorityFee = (1000000000n & ~0xFn) | BigInt(OPERATOR_INDEX);
    tx.maxPriorityFeePerGas = priorityFee;
    tx.maxFeePerGas = baseFee * 2n + priorityFee;
  }
  const resp = await signer.sendTransaction(tx);
  const receipt = await resp.wait();
  console.log(`    gas [${label}]: ${receipt.gasUsed}`);
  return receipt;
}

// Helper: fund WETH via storage override
function wethBalSlot(addr) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [addr, 3])
  );
}

async function fundWeth(target, amount) {
  await ethers.provider.send("hardhat_setStorageAt", [
    WETH_ADDRESS,
    wethBalSlot(target),
    ethers.zeroPadValue(ethers.toBeHex(amount), 32),
  ]);
}

loadVariants().forEach((variant) => {
describe(`RouteSimulatorV2 E2E [${variant.name}]`, function () {
  let sim;
  let mev;
  let weth;
  let tokenA; // token sorted < WETH
  let tokenB; // another token
  let owner;
  let operator;
  let vault; // profit destination
  let variantSnapshot;
  let mevBytecode; // MEV runtime bytecode (restored before command execution)
  let simBytecode; // RouteSimulator runtime bytecode (restored before simulation)

  before(async function () {
    variantSnapshot = await ethers.provider.send("evm_snapshot", []);
    [owner, vault] = await ethers.getSigners();

    // Deploy WETH9 at hardcoded address
    const WETH9 = await ethers.getContractFactory("WETH9");
    const wethTemp = await WETH9.deploy();
    await wethTemp.waitForDeployment();
    const wethCode = await ethers.provider.getCode(wethTemp.target);
    await ethers.provider.send("hardhat_setCode", [WETH_ADDRESS, wethCode]);
    weth = await ethers.getContractAt("WETH9", WETH_ADDRESS);

    // Deploy tokens
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    tokenA = await MockERC20.deploy("Token A", "TKA", 18);
    await tokenA.waitForDeployment();
    tokenB = await MockERC20.deploy("Token B", "TKB", 18);
    await tokenB.waitForDeployment();

    // Deploy MEV_V2 contract first — its address becomes the shared address
    const MEVFactory = new ethers.ContractFactory(variant.abi, variant.bytecode, owner);
    mev = await MEVFactory.deploy();
    await mev.waitForDeployment();
    mevBytecode = await ethers.provider.getCode(mev.target);

    // Deploy RouteSimulatorV2 at the SAME address as MEV (mirrors production state override).
    // This ensures address(this) in simulateFlash == mev.target → balance_check targets correct address.
    const SimFactory = await ethers.getContractFactory("RouteSimulatorV2");
    const simTemp = await SimFactory.deploy();
    await simTemp.waitForDeployment();
    simBytecode = await ethers.provider.getCode(simTemp.target);
    await ethers.provider.send("hardhat_setCode", [mev.target, simBytecode]);
    sim = await ethers.getContractAt("RouteSimulatorV2", mev.target);

    // Impersonate operator
    await ethers.provider.send("hardhat_impersonateAccount", [OPERATOR_ADDRESS]);
    operator = await ethers.getSigner(OPERATOR_ADDRESS);
    await owner.sendTransaction({ to: OPERATOR_ADDRESS, value: ethers.parseEther("100") });
  });

  after(async function () {
    await ethers.provider.send("evm_revert", [variantSnapshot]);
  });

  // ============================================================
  // Test 1: V2 flash 2-hop (V2→V2)
  // ============================================================
  describe("V2 flash 2-hop (V2→V2)", function () {
    let pair1, pair2;
    let flashToken; // non-WETH token borrowed from pair1

    before(async function () {
      // Pair 1: WETH/tokenA — flash pool (borrow tokenA)
      // Pair 2: tokenA/WETH — swap pool (swap tokenA → WETH)
      // Skew reserves so arb exists: pair1 has cheap tokenA, pair2 has expensive tokenA

      const MockV2Pair = await ethers.getContractFactory("MockV2Pair");

      // Pair1: WETH/tokenA — lots of tokenA (cheap), less WETH
      pair1 = await MockV2Pair.deploy(WETH_ADDRESS, tokenA.target, false);
      await pair1.waitForDeployment();
      await weth.connect(owner).deposit({ value: ethers.parseEther("10") });
      await weth.connect(owner).transfer(pair1.target, ethers.parseEther("10"));
      await tokenA.mint(pair1.target, ethers.parseUnits("100000", 18)); // cheap tokenA
      await pair1.sync();

      // Pair2: WETH/tokenA — lots of WETH, less tokenA (expensive tokenA)
      pair2 = await MockV2Pair.deploy(WETH_ADDRESS, tokenA.target, false);
      await pair2.waitForDeployment();
      await weth.connect(owner).deposit({ value: ethers.parseEther("100") });
      await weth.connect(owner).transfer(pair2.target, ethers.parseEther("100"));
      await tokenA.mint(pair2.target, ethers.parseUnits("10000", 18)); // expensive tokenA
      await pair2.sync();

      flashToken = tokenA;
    });

    it("simulateFlash → profit > 0 → commands execute on MEV_V2", async function () {
      const pair1Token0 = await pair1.token0();
      const pair2Token0 = await pair2.token0();

      // Determine flash hop direction:
      // Flash borrows tokenA from pair1
      // zeroForOne: if tokenA is token0, we want token0 → borrow token0 → zfo=false (borrow token0 = v2_flash_z)
      const flashZfo = pair1Token0.toLowerCase() !== flashToken.target.toLowerCase();

      const borrowAmount = ethers.parseUnits("1000", 18);

      // Route: pair1 (flash borrow tokenA) → pair2 (swap tokenA → WETH)
      const innerZfo = pair2Token0.toLowerCase() === flashToken.target.toLowerCase();

      const route = [
        buildHop({
          pool: pair1.target,
          dex: 0,
          zeroForOne: flashZfo,
          tokenIn: WETH_ADDRESS,
          tokenOut: flashToken.target,
          feeBps: 30,
        }),
        buildHop({
          pool: pair2.target,
          dex: 0,
          zeroForOne: innerZfo,
          tokenIn: flashToken.target,
          tokenOut: WETH_ADDRESS,
          feeBps: 30,
        }),
      ];

      // Fund simulator with some WETH for repay
      await fundWeth(sim.target, ethers.parseEther("200"));

      // Run simulateFlash
      await ethers.provider.send("hardhat_setCode", [mev.target, simBytecode]);
      const result = await sim.simulateFlash.staticCall(route, borrowAmount, WETH_ADDRESS, vault.address, 0);
      const profit = result[0];
      const commands = result[1];

      console.log(`    V2 flash 2-hop profit: ${ethers.formatEther(profit)} WETH`);
      expect(profit).to.be.gt(0n, "profit must be > 0");
      expect(commands.length).to.be.gt(0, "commands must not be empty");

      // Restore MEV bytecode for execution (was overwritten with RouteSimulator for simulation)
      await ethers.provider.send("hardhat_setCode", [mev.target, mevBytecode]);
      // Fund MEV contract with WETH for the flash repay


      const receipt = await sendAndLog(operator, {
        to: mev.target,
        data: commands,
        value: BigInt(ethers.dataLength(commands)),
      }, "V2 flash 2-hop E2E");

      // Verify Transfer events
      const transfers = parseTransfers(receipt);

      // Should have: flash borrow (pair1→mev), inner swap (mev→pair2, pair2→mev), repay (mev→pair1), profit sweep (mev→vault)
      expect(transfers.length).to.be.gte(3, "at least 3 Transfer events expected");

      // Verify sweep: WETH Transfer from mev to vault
      const sweepXfer = transfers.find(t =>
        t.from.toLowerCase() === mev.target.toLowerCase() &&
        t.to.toLowerCase() === vault.address.toLowerCase() &&
        t.token === WETH_ADDRESS.toLowerCase()
      );
      expect(sweepXfer, "WETH sweep Transfer to vault must exist").to.exist;
      expect(sweepXfer.value).to.be.gte(profit, "sweep amount must be >= profit");
      console.log(`    swept to vault: ${ethers.formatEther(sweepXfer.value)} WETH`);
    });
  });

  // ============================================================
  // Test 2: V3 flash swap 2-hop (V3→V2)
  // ============================================================
  describe("V3 flash swap 2-hop (V3→V2)", function () {
    let v3Pool, v2Pair;
    let v3PoolAddress;
    let v3Token0, v3Token1;

    before(async function () {
      // Determine V3 token order
      if (BigInt(WETH_ADDRESS) < BigInt(tokenA.target)) {
        v3Token0 = WETH_ADDRESS;
        v3Token1 = tokenA.target;
      } else {
        v3Token0 = tokenA.target;
        v3Token1 = WETH_ADDRESS;
      }

      const FEE = 3000;
      const salt = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "address", "uint24"],
          [v3Token0, v3Token1, FEE]
        )
      );
      v3PoolAddress = ethers.getCreate2Address(UNI_V3_FACTORY, salt, POOL_INIT_CODE_HASH);

      // Deploy mock V3 pool at computed address
      const MockV3Pool = await ethers.getContractFactory("MockV3Pool");
      const tempPool = await MockV3Pool.deploy(v3Token0, v3Token1, FEE, false);
      await tempPool.waitForDeployment();
      const poolCode = await ethers.provider.getCode(tempPool.target);
      await ethers.provider.send("hardhat_setCode", [v3PoolAddress, poolCode]);

      // Fund V3 pool: cheap tokenA, more WETH
      await weth.connect(owner).deposit({ value: ethers.parseEther("50") });
      await weth.connect(owner).transfer(v3PoolAddress, ethers.parseEther("50"));
      await tokenA.mint(v3PoolAddress, ethers.parseUnits("50000", 18));

      // V2 pair: expensive tokenA (for arb opportunity)
      const MockV2Pair = await ethers.getContractFactory("MockV2Pair");
      v2Pair = await MockV2Pair.deploy(WETH_ADDRESS, tokenA.target, false);
      await v2Pair.waitForDeployment();
      await weth.connect(owner).deposit({ value: ethers.parseEther("100") });
      await weth.connect(owner).transfer(v2Pair.target, ethers.parseEther("100"));
      await tokenA.mint(v2Pair.target, ethers.parseUnits("5000", 18));
      await v2Pair.sync();
    });

    it("simulateFlash → profit > 0 → commands execute on MEV_V2", async function () {
      // Flash borrow tokenA from V3 pool, swap tokenA→WETH on V2 pair
      const flashZfo = v3Token0.toLowerCase() === WETH_ADDRESS.toLowerCase();

      const borrowAmount = ethers.parseUnits("500", 18);

      const pair2Token0 = await v2Pair.token0();
      const innerZfo = pair2Token0.toLowerCase() === tokenA.target.toLowerCase();

      const route = [
        buildHop({
          pool: v3PoolAddress,
          dex: 1,
          zeroForOne: flashZfo,
          tokenIn: WETH_ADDRESS,
          tokenOut: tokenA.target,
          feeBps: 3000,
        }),
        buildHop({
          pool: v2Pair.target,
          dex: 0,
          zeroForOne: innerZfo,
          tokenIn: tokenA.target,
          tokenOut: WETH_ADDRESS,
          feeBps: 30,
        }),
      ];

      // Fund simulator
      await fundWeth(sim.target, ethers.parseEther("200"));

      await ethers.provider.send("hardhat_setCode", [mev.target, simBytecode]);
      const result = await sim.simulateFlash.staticCall(route, borrowAmount, WETH_ADDRESS, vault.address, 0);
      const profit = result[0];
      const commands = result[1];

      console.log(`    V3 flash 2-hop profit: ${ethers.formatEther(profit)} WETH`);
      expect(profit).to.be.gt(0n, "profit must be > 0");

      // Restore MEV bytecode for execution
      await ethers.provider.send("hardhat_setCode", [mev.target, mevBytecode]);


      const receipt = await sendAndLog(operator, {
        to: mev.target,
        data: commands,
        value: BigInt(ethers.dataLength(commands)),
      }, "V3 flash 2-hop E2E");

      const transfers = parseTransfers(receipt);
      expect(transfers.length).to.be.gte(3, "at least 3 Transfer events expected");

      // Verify sweep to vault
      const sweepXfer = transfers.find(t =>
        t.from.toLowerCase() === mev.target.toLowerCase() &&
        t.to.toLowerCase() === vault.address.toLowerCase() &&
        t.token === WETH_ADDRESS.toLowerCase()
      );
      expect(sweepXfer, "WETH sweep Transfer to vault must exist").to.exist;
      expect(sweepXfer.value).to.be.gt(0n);
      console.log(`    swept to vault: ${ethers.formatEther(sweepXfer.value)} WETH`);
    });
  });

  // ============================================================
  // Test 3: V2 flash 3-hop triangle (V2→V2→V2)
  // ============================================================
  describe("V2 flash 3-hop triangle (V2→V2→V2)", function () {
    let pair1, pair2, pair3;

    before(async function () {
      const MockV2Pair = await ethers.getContractFactory("MockV2Pair");

      // Pair1: WETH/tokenA — flash (borrow tokenA cheaply)
      pair1 = await MockV2Pair.deploy(WETH_ADDRESS, tokenA.target, false);
      await pair1.waitForDeployment();
      await weth.connect(owner).deposit({ value: ethers.parseEther("10") });
      await weth.connect(owner).transfer(pair1.target, ethers.parseEther("10"));
      await tokenA.mint(pair1.target, ethers.parseUnits("100000", 18));
      await pair1.sync();

      // Pair2: tokenA/tokenB — swap A→B (skewed: lots of tokenB)
      pair2 = await MockV2Pair.deploy(tokenA.target, tokenB.target, false);
      await pair2.waitForDeployment();
      await tokenA.mint(pair2.target, ethers.parseUnits("10000", 18));
      await tokenB.mint(pair2.target, ethers.parseUnits("100000", 18));
      await pair2.sync();

      // Pair3: tokenB/WETH — swap B→WETH (skewed: lots of WETH for expensive tokenB)
      pair3 = await MockV2Pair.deploy(tokenB.target, WETH_ADDRESS, false);
      await pair3.waitForDeployment();
      await weth.connect(owner).deposit({ value: ethers.parseEther("100") });
      await weth.connect(owner).transfer(pair3.target, ethers.parseEther("100"));
      await tokenB.mint(pair3.target, ethers.parseUnits("5000", 18));
      await pair3.sync();
    });

    it("simulateFlash → profit > 0 → commands execute on MEV_V2", async function () {
      const p1Token0 = await pair1.token0();
      const p2Token0 = await pair2.token0();
      const p3Token0 = await pair3.token0();

      // Flash borrow tokenA from pair1
      const flashZfo = p1Token0.toLowerCase() !== tokenA.target.toLowerCase();
      // Inner hop 1: tokenA → tokenB via pair2
      const hop2Zfo = p2Token0.toLowerCase() === tokenA.target.toLowerCase();
      // Inner hop 2: tokenB → WETH via pair3
      const hop3Zfo = p3Token0.toLowerCase() === tokenB.target.toLowerCase();

      const borrowAmount = ethers.parseUnits("1000", 18);

      const route = [
        buildHop({
          pool: pair1.target, dex: 0, zeroForOne: flashZfo,
          tokenIn: WETH_ADDRESS, tokenOut: tokenA.target, feeBps: 30,
        }),
        buildHop({
          pool: pair2.target, dex: 0, zeroForOne: hop2Zfo,
          tokenIn: tokenA.target, tokenOut: tokenB.target, feeBps: 30,
        }),
        buildHop({
          pool: pair3.target, dex: 0, zeroForOne: hop3Zfo,
          tokenIn: tokenB.target, tokenOut: WETH_ADDRESS, feeBps: 30,
        }),
      ];

      await fundWeth(sim.target, ethers.parseEther("200"));

      await ethers.provider.send("hardhat_setCode", [mev.target, simBytecode]);
      const result = await sim.simulateFlash.staticCall(route, borrowAmount, WETH_ADDRESS, vault.address, 0);
      const profit = result[0];
      const commands = result[1];

      console.log(`    V2 flash 3-hop profit: ${ethers.formatEther(profit)} WETH`);
      expect(profit).to.be.gt(0n, "profit must be > 0");

      // Restore MEV bytecode for execution
      await ethers.provider.send("hardhat_setCode", [mev.target, mevBytecode]);


      const receipt = await sendAndLog(operator, {
        to: mev.target,
        data: commands,
        value: BigInt(ethers.dataLength(commands)),
      }, "V2 flash 3-hop E2E");

      const transfers = parseTransfers(receipt);
      expect(transfers.length).to.be.gte(4, "at least 4 Transfer events for 3-hop");

      // Verify sweep to vault
      const sweepXfer = transfers.find(t =>
        t.from.toLowerCase() === mev.target.toLowerCase() &&
        t.to.toLowerCase() === vault.address.toLowerCase() &&
        t.token === WETH_ADDRESS.toLowerCase()
      );
      expect(sweepXfer, "WETH sweep Transfer to vault must exist").to.exist;
      expect(sweepXfer.value).to.be.gt(0n);
      console.log(`    swept to vault: ${ethers.formatEther(sweepXfer.value)} WETH`);
    });
  });

  // ============================================================
  // Test 4: Mixed V2 flash + V3 swap (V2→V3)
  // ============================================================
  describe("Mixed: V2 flash + V3 swap (V2→V3)", function () {
    let v2Pair, v3PoolAddr;
    let v3Token0, v3Token1;

    before(async function () {
      const MockV2Pair = await ethers.getContractFactory("MockV2Pair");

      // V2 pair: WETH/tokenB — flash (borrow tokenB cheaply)
      v2Pair = await MockV2Pair.deploy(WETH_ADDRESS, tokenB.target, false);
      await v2Pair.waitForDeployment();
      await weth.connect(owner).deposit({ value: ethers.parseEther("10") });
      await weth.connect(owner).transfer(v2Pair.target, ethers.parseEther("10"));
      await tokenB.mint(v2Pair.target, ethers.parseUnits("100000", 18));
      await v2Pair.sync();

      // V3 pool: tokenB/WETH — swap B→WETH (expensive tokenB for arb)
      if (BigInt(WETH_ADDRESS) < BigInt(tokenB.target)) {
        v3Token0 = WETH_ADDRESS;
        v3Token1 = tokenB.target;
      } else {
        v3Token0 = tokenB.target;
        v3Token1 = WETH_ADDRESS;
      }

      const FEE = 500;
      const salt = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "address", "uint24"],
          [v3Token0, v3Token1, FEE]
        )
      );
      v3PoolAddr = ethers.getCreate2Address(UNI_V3_FACTORY, salt, POOL_INIT_CODE_HASH);

      const MockV3Pool = await ethers.getContractFactory("MockV3Pool");
      const tempPool = await MockV3Pool.deploy(v3Token0, v3Token1, FEE, false);
      await tempPool.waitForDeployment();
      const poolCode = await ethers.provider.getCode(tempPool.target);
      await ethers.provider.send("hardhat_setCode", [v3PoolAddr, poolCode]);

      // Fund V3: expensive tokenB (less tokenB, more WETH)
      await weth.connect(owner).deposit({ value: ethers.parseEther("100") });
      await weth.connect(owner).transfer(v3PoolAddr, ethers.parseEther("100"));
      await tokenB.mint(v3PoolAddr, ethers.parseUnits("5000", 18));
    });

    it("simulateFlash → profit > 0 → commands execute on MEV_V2", async function () {
      const v2Token0 = await v2Pair.token0();

      // Flash borrow tokenB from V2 pair
      const flashZfo = v2Token0.toLowerCase() !== tokenB.target.toLowerCase();
      // Inner: tokenB → WETH via V3
      const innerZfo = v3Token0.toLowerCase() === tokenB.target.toLowerCase();

      const borrowAmount = ethers.parseUnits("1000", 18);

      const route = [
        buildHop({
          pool: v2Pair.target, dex: 0, zeroForOne: flashZfo,
          tokenIn: WETH_ADDRESS, tokenOut: tokenB.target, feeBps: 30,
        }),
        buildHop({
          pool: v3PoolAddr, dex: 1, zeroForOne: innerZfo,
          tokenIn: tokenB.target, tokenOut: WETH_ADDRESS, feeBps: 500,
        }),
      ];

      await fundWeth(sim.target, ethers.parseEther("200"));

      await ethers.provider.send("hardhat_setCode", [mev.target, simBytecode]);
      const result = await sim.simulateFlash.staticCall(route, borrowAmount, WETH_ADDRESS, vault.address, 0);
      const profit = result[0];
      const commands = result[1];

      console.log(`    Mixed V2+V3 profit: ${ethers.formatEther(profit)} WETH`);
      expect(profit).to.be.gt(0n, "profit must be > 0");

      // Restore MEV bytecode for execution
      await ethers.provider.send("hardhat_setCode", [mev.target, mevBytecode]);


      const receipt = await sendAndLog(operator, {
        to: mev.target,
        data: commands,
        value: BigInt(ethers.dataLength(commands)),
      }, "Mixed V2+V3 E2E");

      const transfers = parseTransfers(receipt);
      expect(transfers.length).to.be.gte(3, "at least 3 Transfer events expected");

      // Verify sweep to vault
      const sweepXfer = transfers.find(t =>
        t.from.toLowerCase() === mev.target.toLowerCase() &&
        t.to.toLowerCase() === vault.address.toLowerCase() &&
        t.token === WETH_ADDRESS.toLowerCase()
      );
      expect(sweepXfer, "WETH sweep Transfer to vault must exist").to.exist;
      expect(sweepXfer.value).to.be.gt(0n);
      console.log(`    swept to vault: ${ethers.formatEther(sweepXfer.value)} WETH`);
    });
    // ============================================================
  // Test 5: Flash slippage (bips=0 reverts after price shift, bips=50 succeeds)
  // ============================================================
  describe("Flash slippage protection", function () {
    let pair1, pair2;
    let flashToken;

    before(async function () {
      const MockV2Pair = await ethers.getContractFactory("MockV2Pair");

      // Pair1: WETH/tokenA — flash pool
      pair1 = await MockV2Pair.deploy(WETH_ADDRESS, tokenA.target, false);
      await pair1.waitForDeployment();
      await weth.connect(owner).deposit({ value: ethers.parseEther("10") });
      await weth.connect(owner).transfer(pair1.target, ethers.parseEther("10"));
      await tokenA.mint(pair1.target, ethers.parseUnits("100000", 18));
      await pair1.sync();

      // Pair2: WETH/tokenA — swap pool (expensive tokenA for arb)
      pair2 = await MockV2Pair.deploy(WETH_ADDRESS, tokenA.target, false);
      await pair2.waitForDeployment();
      await weth.connect(owner).deposit({ value: ethers.parseEther("100") });
      await weth.connect(owner).transfer(pair2.target, ethers.parseEther("100"));
      await tokenA.mint(pair2.target, ethers.parseUnits("10000", 18));
      await pair2.sync();

      flashToken = tokenA;
    });

    it("bips=0 reverts after price shift, bips=50 succeeds", async function () {
      const pair1Token0 = await pair1.token0();
      const pair2Token0 = await pair2.token0();
      const flashZfo = pair1Token0.toLowerCase() !== flashToken.target.toLowerCase();
      const innerZfo = pair2Token0.toLowerCase() === flashToken.target.toLowerCase();
      const borrowAmount = ethers.parseUnits("1000", 18);

      const route = [
        buildHop({
          pool: pair1.target, dex: 0, zeroForOne: flashZfo,
          tokenIn: WETH_ADDRESS, tokenOut: flashToken.target, feeBps: 30,
        }),
        buildHop({
          pool: pair2.target, dex: 0, zeroForOne: innerZfo,
          tokenIn: flashToken.target, tokenOut: WETH_ADDRESS, feeBps: 30,
        }),
      ];

      await fundWeth(sim.target, ethers.parseEther("200"));

      // Simulate with bips=0 (no tolerance)
      await ethers.provider.send("hardhat_setCode", [mev.target, simBytecode]);
      const res0 = await sim.simulateFlash.staticCall(route, borrowAmount, WETH_ADDRESS, vault.address, 0);
      const commands0 = res0[1];
      const profit0 = res0[0];
      expect(profit0).to.be.gt(0n, "must be profitable before shift");

      // Simulate with bips=500 (5% tolerance)
      const res500 = await sim.simulateFlash.staticCall(route, borrowAmount, WETH_ADDRESS, vault.address, 500);
      const commands500 = res500[1];

      // Shift price on pair2: add tokenA → pair2 has more tokenA → tokenA cheaper → less WETH out
      // ~2.5% of pair2 reserves (10000 tokenA) → profit drops ~2.5%
      const shiftAmount = ethers.parseUnits("250", 18);
      await tokenA.mint(pair2.target, shiftAmount);
      await pair2.sync();

      // Restore MEV bytecode for execution
      await ethers.provider.send("hardhat_setCode", [mev.target, mevBytecode]);

      // bips=0 should revert (balance_check fails after price shift)
      await expect(
        operator.sendTransaction({
          to: mev.target,
          data: commands0,
          value: BigInt(ethers.dataLength(commands0)),
        })
      ).to.be.reverted;

      // bips=500 should succeed (5% tolerance absorbs the ~2.5% shift)
      const receipt = await sendAndLog(operator, {
        to: mev.target,
        data: commands500,
        value: BigInt(ethers.dataLength(commands500)),
      }, "Flash slippage bips=500");

      const transfers = parseTransfers(receipt);
      const sweepXfer = transfers.find(t =>
        t.from.toLowerCase() === mev.target.toLowerCase() &&
        t.to.toLowerCase() === vault.address.toLowerCase() &&
        t.token === WETH_ADDRESS.toLowerCase()
      );
      expect(sweepXfer, "WETH sweep Transfer to vault must exist").to.exist;
      expect(sweepXfer.value).to.be.gt(0n);
      console.log(`    slippage test swept: ${ethers.formatEther(sweepXfer.value)} WETH`);
    });
  });

  // ============================================================
  // Test 6: Sandwich slippage (backrun bips=0 reverts, bips=50 succeeds)
  // ============================================================
  describe("Sandwich slippage protection", function () {
    let pair1;

    before(async function () {
      const MockV2Pair = await ethers.getContractFactory("MockV2Pair");

      // Pair1: WETH/tokenA — sandwich target
      pair1 = await MockV2Pair.deploy(WETH_ADDRESS, tokenA.target, false);
      await pair1.waitForDeployment();
      await weth.connect(owner).deposit({ value: ethers.parseEther("50") });
      await weth.connect(owner).transfer(pair1.target, ethers.parseEther("50"));
      await tokenA.mint(pair1.target, ethers.parseUnits("50000", 18));
      await pair1.sync();
    });

    it("backrun bips=0 reverts after price shift, bips=50 succeeds", async function () {
      const pair1Token0 = await pair1.token0();
      const frontZfo = pair1Token0.toLowerCase() === WETH_ADDRESS.toLowerCase();

      const frontRoute = [
        buildHop({
          pool: pair1.target, dex: 0, zeroForOne: frontZfo,
          tokenIn: WETH_ADDRESS, tokenOut: tokenA.target, feeBps: 30,
        }),
      ];

      const frontAmount = ethers.parseEther("5");
      await fundWeth(sim.target, ethers.parseEther("200"));

      // Execute frontrun (mutates state)
      await ethers.provider.send("hardhat_setCode", [mev.target, simBytecode]);
      await sim.frontrun(frontRoute, frontAmount);

      // Backrun with bips=0
      const back0 = await sim.backrun.staticCall(vault.address, 0);
      const backCommands0 = back0[1];

      // Backrun with bips=500 (5%)
      const back500 = await sim.backrun.staticCall(vault.address, 500);
      const backCommands500 = back500[1];

      // Shift price: add tokenA to pair1 → tokenA cheaper → tokenA→WETH gives less WETH
      // After frontrun, pair1 has ~50000+X tokenA. Add ~2.5% more.
      const shiftAmount = ethers.parseUnits("1250", 18);
      await tokenA.mint(pair1.target, shiftAmount);
      await pair1.sync();

      // Restore MEV bytecode for execution
      await ethers.provider.send("hardhat_setCode", [mev.target, mevBytecode]);

      // bips=0 should revert (balance_check fails after price shift)
      await expect(
        operator.sendTransaction({
          to: mev.target,
          data: backCommands0,
          value: BigInt(ethers.dataLength(backCommands0)),
        })
      ).to.be.reverted;

      // bips=500 should succeed (5% tolerance absorbs the ~2.5% shift)
      const receipt = await sendAndLog(operator, {
        to: mev.target,
        data: backCommands500,
        value: BigInt(ethers.dataLength(backCommands500)),
      }, "Sandwich slippage bips=500");

      const transfers = parseTransfers(receipt);
      const sweepXfer = transfers.find(t =>
        t.from.toLowerCase() === mev.target.toLowerCase() &&
        t.to.toLowerCase() === vault.address.toLowerCase() &&
        t.token === WETH_ADDRESS.toLowerCase()
      );
      expect(sweepXfer, "WETH sweep Transfer to vault must exist").to.exist;
      expect(sweepXfer.value).to.be.gt(0n);
      console.log(`    sandwich slippage swept: ${ethers.formatEther(sweepXfer.value)} WETH`);
    });
  });

  // ============================================================
  // Test: Fee-on-transfer token — _flashAmountIn uses balanceOf
  // Verifies that V2 flash callback updates _flashAmountIn to actual
  // received balance (not pool-reported amount) for fee-on-transfer tokens.
  // ============================================================
  describe("Fee-on-transfer flash (V2→V2)", function () {
    let pair1, pair2;
    let feeToken;

    before(async function () {
      // Deploy fee-on-transfer token with 5% tax
      const MockFeeOnTransfer = await ethers.getContractFactory("MockFeeOnTransferERC20");
      feeToken = await MockFeeOnTransfer.deploy("Fee Token", "FEE", 18, 500);
      await feeToken.waitForDeployment();

      const MockV2Pair = await ethers.getContractFactory("MockV2Pair");

      // Pair1: WETH/feeToken — flash pool (borrow feeToken)
      pair1 = await MockV2Pair.deploy(WETH_ADDRESS, feeToken.target, false);
      await pair1.waitForDeployment();
      await weth.connect(owner).deposit({ value: ethers.parseEther("10") });
      await weth.connect(owner).transfer(pair1.target, ethers.parseEther("10"));
      await feeToken.mint(pair1.target, ethers.parseUnits("100000", 18));
      await pair1.sync();

      // Pair2: WETH/feeToken — swap pool (expensive feeToken for arb)
      pair2 = await MockV2Pair.deploy(WETH_ADDRESS, feeToken.target, false);
      await pair2.waitForDeployment();
      await weth.connect(owner).deposit({ value: ethers.parseEther("100") });
      await weth.connect(owner).transfer(pair2.target, ethers.parseEther("100"));
      await feeToken.mint(pair2.target, ethers.parseUnits("10000", 18));
      await pair2.sync();
    });

    it("simulateFlash handles reduced amount from fee-on-transfer token", async function () {
      const pair1Token0 = await pair1.token0();
      const pair2Token0 = await pair2.token0();
      const flashZfo = pair1Token0.toLowerCase() !== feeToken.target.toLowerCase();
      const innerZfo = pair2Token0.toLowerCase() === feeToken.target.toLowerCase();
      const borrowAmount = ethers.parseUnits("1000", 18);

      const route = [
        buildHop({
          pool: pair1.target, dex: 0, zeroForOne: flashZfo,
          tokenIn: WETH_ADDRESS, tokenOut: feeToken.target, feeBps: 30,
        }),
        buildHop({
          pool: pair2.target, dex: 0, zeroForOne: innerZfo,
          tokenIn: feeToken.target, tokenOut: WETH_ADDRESS, feeBps: 30,
        }),
      ];

      await fundWeth(sim.target, ethers.parseEther("200"));

      // Run simulateFlash — should NOT revert with TRF despite fee-on-transfer
      await ethers.provider.send("hardhat_setCode", [mev.target, simBytecode]);
      const result = await sim.simulateFlash.staticCall(route, borrowAmount, WETH_ADDRESS, vault.address, 0);
      const profit = result[0];
      const commands = result[1];
      const amounts = result[2];

      console.log(`    fee-on-transfer flash profit: ${ethers.formatEther(profit)} WETH`);

      // Flash borrow amount (amounts[0][1]) is the requested borrow
      // Actual received is 5% less due to tax
      const flashBorrow = amounts[0][1];
      const innerInput = amounts[1][0];
      console.log(`    flash borrow requested: ${ethers.formatUnits(flashBorrow, 18)}`);
      console.log(`    inner hop input (actual received): ${ethers.formatUnits(innerInput, 18)}`);

      // Inner input must be less than flash borrow (tax deducted)
      expect(innerInput).to.be.lt(flashBorrow, "inner input must be < flash borrow due to transfer tax");

      // Should still produce commands (simulation completed without revert)
      expect(commands.length).to.be.gt(0, "commands must not be empty");
    });
  });

  // ============================================================
  // Test: TRF / TF — blacklisted token causes transfer revert
  // Reproduces production errors:
  //   [SF] flash: [S] hop 0: TRF  (safeTransfer returns false)
  //   [SF] flash: [S] hop 0: TF   (token reverts with "TF")
  // ============================================================
  describe("TRF/TF — blacklisted token revert", function () {
    let pair1, pair2;
    let badToken;

    before(async function () {
      // Deploy blacklist token — transfer() reverts with "TF" when sender blacklisted
      const MockBlacklistERC20 = await ethers.getContractFactory("MockBlacklistERC20");
      badToken = await MockBlacklistERC20.deploy("Bad Token", "BAD", 18);
      await badToken.waitForDeployment();

      const MockV2Pair = await ethers.getContractFactory("MockV2Pair");

      // Pair1: WETH/badToken — flash pool (borrow badToken)
      pair1 = await MockV2Pair.deploy(WETH_ADDRESS, badToken.target, false);
      await pair1.waitForDeployment();
      await weth.connect(owner).deposit({ value: ethers.parseEther("10") });
      await weth.connect(owner).transfer(pair1.target, ethers.parseEther("10"));
      await badToken.mint(pair1.target, ethers.parseUnits("100000", 18));
      await pair1.sync();

      // Pair2: WETH/badToken — swap pool (swap badToken → WETH)
      pair2 = await MockV2Pair.deploy(WETH_ADDRESS, badToken.target, false);
      await pair2.waitForDeployment();
      await weth.connect(owner).deposit({ value: ethers.parseEther("100") });
      await weth.connect(owner).transfer(pair2.target, ethers.parseEther("100"));
      await badToken.mint(pair2.target, ethers.parseUnits("10000", 18));
      await pair2.sync();
    });

    it("simulateFlash reverts with TF when RouteSimulator is blacklisted", async function () {
      // Blacklist the RouteSimulator address — token.transfer TO us reverts with "TF"
      // This happens at flash level: flash pool tries to send borrowed tokens to us
      // → IERC20.transfer(sim, amount) → reverts with "TF"
      // → flash swap itself reverts → caught as [SF] flash: TF
      await badToken.setBlacklisted(sim.target, true);

      const pair1Token0 = await pair1.token0();
      const flashZfo = pair1Token0.toLowerCase() !== badToken.target.toLowerCase();
      const pair2Token0 = await pair2.token0();
      const innerZfo = pair2Token0.toLowerCase() === badToken.target.toLowerCase();

      const route = [
        buildHop({
          pool: pair1.target, dex: 0, zeroForOne: flashZfo,
          tokenIn: WETH_ADDRESS, tokenOut: badToken.target, feeBps: 30,
        }),
        buildHop({
          pool: pair2.target, dex: 0, zeroForOne: innerZfo,
          tokenIn: badToken.target, tokenOut: WETH_ADDRESS, feeBps: 30,
        }),
      ];

      await fundWeth(sim.target, ethers.parseEther("200"));
      await ethers.provider.send("hardhat_setCode", [mev.target, simBytecode]);

      // Flash pool calls badToken.transfer(sim, amount) → reverts "TF" (sim blacklisted)
      // → executeFlash catches revert → bubbles as [SF] flash: TF
      await expect(
        sim.simulateFlash.staticCall(route, ethers.parseUnits("1000", 18), WETH_ADDRESS, vault.address, 0)
      ).to.be.revertedWith("[SF] flash: TF");

      console.log("    confirmed: blacklisted receiver → [SF] flash: TF (flash-level revert)");
    });

    it("simulateFlash succeeds after removing from blacklist", async function () {
      // Remove blacklist — same chain should now produce profit
      await badToken.setBlacklisted(sim.target, false);

      const pair1Token0 = await pair1.token0();
      const flashZfo = pair1Token0.toLowerCase() !== badToken.target.toLowerCase();
      const pair2Token0 = await pair2.token0();
      const innerZfo = pair2Token0.toLowerCase() === badToken.target.toLowerCase();

      const route = [
        buildHop({
          pool: pair1.target, dex: 0, zeroForOne: flashZfo,
          tokenIn: WETH_ADDRESS, tokenOut: badToken.target, feeBps: 30,
        }),
        buildHop({
          pool: pair2.target, dex: 0, zeroForOne: innerZfo,
          tokenIn: badToken.target, tokenOut: WETH_ADDRESS, feeBps: 30,
        }),
      ];

      await fundWeth(sim.target, ethers.parseEther("200"));
      await ethers.provider.send("hardhat_setCode", [mev.target, simBytecode]);

      const result = await sim.simulateFlash.staticCall(route, ethers.parseUnits("1000", 18), WETH_ADDRESS, vault.address, 0);
      const profit = result[0];

      expect(profit).to.be.gt(0n, "profit must be > 0 after blacklist removed");
      console.log(`    profit after unblacklist: ${ethers.formatEther(profit)} WETH`);
    });

    it("simulateFlash reverts with TRF when recipient pool is blacklisted", async function () {
      // Blacklist pair2 (the recipient of safeTransfer) — transfer TO it will revert
      await badToken.setBlacklisted(pair2.target, true);
      await badToken.setBlacklisted(sim.target, false);

      const pair1Token0 = await pair1.token0();
      const flashZfo = pair1Token0.toLowerCase() !== badToken.target.toLowerCase();
      const pair2Token0 = await pair2.token0();
      const innerZfo = pair2Token0.toLowerCase() === badToken.target.toLowerCase();

      const route = [
        buildHop({
          pool: pair1.target, dex: 0, zeroForOne: flashZfo,
          tokenIn: WETH_ADDRESS, tokenOut: badToken.target, feeBps: 30,
        }),
        buildHop({
          pool: pair2.target, dex: 0, zeroForOne: innerZfo,
          tokenIn: badToken.target, tokenOut: WETH_ADDRESS, feeBps: 30,
        }),
      ];

      await fundWeth(sim.target, ethers.parseEther("200"));
      await ethers.provider.send("hardhat_setCode", [mev.target, simBytecode]);

      // safeTransfer(badToken, pair2, amount)
      //   → token.call(transfer(pair2, amount)) → reverts with "TF" (pair2 blacklisted)
      //   → success=false → safeTransfer returns false → require(false, 'TRF')
      await expect(
        sim.simulateFlash.staticCall(route, ethers.parseUnits("1000", 18), WETH_ADDRESS, vault.address, 0)
      ).to.be.revertedWith("[SF] flash: [S] hop 0: TRF");

      console.log("    confirmed: blacklisted recipient on V2 path → [SF] flash: [S] hop 0: TRF");

      // Cleanup
      await badToken.setBlacklisted(pair2.target, false);
    });
  });
});
});
});
