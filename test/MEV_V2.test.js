const { expect } = require("chai");
const { ethers } = require("hardhat");

// Helper: send tx and log gas used
// Auto-sets priority fee with operator index in low 4 bits for multi-operator auth
async function sendAndLog(signer, tx, label) {
  if (tx.maxPriorityFeePerGas === undefined) {
    const block = await ethers.provider.getBlock("latest");
    const baseFee = block.baseFeePerGas || 1000000000n;
    const priorityFee = (1000000000n & ~0xFn) | BigInt(OPERATOR_INDEX);
    tx.maxPriorityFeePerGas = priorityFee;
    // Use high maxFeePerGas to prevent baseFee drift across blocks from capping effective gas price
    tx.maxFeePerGas = baseFee * 2n + priorityFee;
  }
  const resp = await signer.sendTransaction(tx);
  const receipt = await resp.wait();
  console.log(`    gas [${label}]: ${receipt.gasUsed}`);
  return receipt;
}

// Event topic hashes
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");
const APPROVAL_TOPIC = ethers.id("Approval(address,address,uint256)");

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

function parseApprovals(receipt) {
  return receipt.logs
    .filter(l => l.topics[0] === APPROVAL_TOPIC)
    .map(l => ({
      owner: "0x" + l.topics[1].slice(26),
      spender: "0x" + l.topics[2].slice(26),
      value: BigInt(l.data),
      token: l.address.toLowerCase(),
    }));
}

// Hardcoded addresses
const WETH_ADDRESS = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const OPERATOR_ADDRESS = "0x0000000000000000000000000000000000000001";
const OPERATOR_INDEX = 0;
const BALANCER_VAULT_ADDRESS = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";

async function withOperatorFee(tx) {
  const block = await ethers.provider.getBlock("latest");
  const baseFee = block.baseFeePerGas || 1000000000n;
  const priorityFee = (1000000000n & ~0xFn) | BigInt(OPERATOR_INDEX);
  return { ...tx, maxPriorityFeePerGas: priorityFee, maxFeePerGas: baseFee * 2n + priorityFee };
}

// Pack helpers
function packAmount112(amount) {
  return BigInt(amount).toString(16).padStart(28, "0");
}
function packAmount72(amount) {
  return BigInt(amount).toString(16).padStart(18, "0");
}
function packAddress(addr) {
  return addr.toLowerCase().replace("0x", "");
}
function packFee(fee) {
  return fee.toString(16).padStart(6, "0");
}
function packFeeBps(feeBps) {
  return feeBps.toString(16).padStart(4, "0");
}

// Well-known selectors
const V2_SWAP_SELECTOR = "022c0d9f"; // swap(uint256,uint256,address,bytes)
const V3_SWAP_SELECTOR = "128acb08"; // swap(address,bool,int256,uint160,bytes)
const BAL_SWAP_SELECTOR = "52bbbe29"; // Balancer vault swap()
const BAL_V1_SWAP_SELECTOR = "8201aa3f"; // swapExactAmountIn
const CURVE_STABLE_SELECTOR = "3df02124"; // exchange(int128,int128,uint256,uint256)
const CURVE_CRYPTO_SELECTOR = "5b41b908"; // exchange(uint256,uint256,uint256,uint256)
const FLUID_SWAP_SELECTOR = "f9366446"; // swap(bool,uint256,uint256,address)
const DODO_SELL_BASE_SELECTOR = "bd6015b4"; // sellBase(address)
const DODO_SELL_QUOTE_SELECTOR = "dd93f59a"; // sellQuote(address)

// Wrap runtime bytecode in minimal deployer
function wrapRuntimeBytecode(runtimeHex) {
  const runtime = runtimeHex.startsWith("0x") ? runtimeHex.slice(2) : runtimeHex;
  const initCode = "600b380380600b5f395ff3";
  return "0x" + initCode + runtime;
}

// Load Yul + Huff variants. Both must be present — Yul/Huff parity is the point of the suite.
function loadVariants() {
  const fs = require("fs");
  const path = require("path");
  const MEVJson = require("../artifacts/contracts/MEV_V2.yul/MEV_V2.json");
  const huffBinPath = path.join(__dirname, "..", "artifacts", "MEV_V2_huff.bin");
  if (!fs.existsSync(huffBinPath)) {
    throw new Error(
      `Huff runtime bytecode not found at ${huffBinPath}. ` +
      `Install huffc (https://docs.huff.sh/get-started/installing/) and run: ` +
      `huffc contracts/MEV_V2.huff -r > artifacts/MEV_V2_huff.bin`
    );
  }
  const huffRuntime = fs.readFileSync(huffBinPath, "utf8").trim();
  return [
    { name: "Yul",  abi: MEVJson.abi, bytecode: MEVJson.bytecode },
    { name: "Huff", abi: MEVJson.abi, bytecode: wrapRuntimeBytecode(huffRuntime) },
  ];
}

loadVariants().forEach((variant) => {
describe(`MEV_V2 [${variant.name}]`, function () {
  let mev;
  let weth;
  let token;
  let operator;
  let owner;
  let alice;
  let variantSnapshot;

  before(async function () {
    variantSnapshot = await ethers.provider.send("evm_snapshot", []);
    [owner, alice] = await ethers.getSigners();

    // Deploy WETH9 to hardcoded address
    const WETH9 = await ethers.getContractFactory("WETH9");
    const wethTemp = await WETH9.deploy();
    await wethTemp.waitForDeployment();
    const wethCode = await ethers.provider.getCode(wethTemp.target);
    await ethers.provider.send("hardhat_setCode", [WETH_ADDRESS, wethCode]);
    weth = await ethers.getContractAt("WETH9", WETH_ADDRESS);

    // Deploy MockERC20
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    token = await MockERC20.deploy("Test Token", "TST", 18);
    await token.waitForDeployment();

    // Deploy MEV_V2 contract
    const MEVFactory = new ethers.ContractFactory(variant.abi, variant.bytecode, owner);
    mev = await MEVFactory.deploy();
    await mev.waitForDeployment();

    // Impersonate operator
    await ethers.provider.send("hardhat_impersonateAccount", [OPERATOR_ADDRESS]);
    operator = await ethers.getSigner(OPERATOR_ADDRESS);
    await owner.sendTransaction({ to: OPERATOR_ADDRESS, value: ethers.parseEther("100") });
  });

  after(async function () {
    await ethers.provider.send("evm_revert", [variantSnapshot]);
  });

  // ============================================================
  // 0x08: Wrap WETH (adaptive: 14 bytes, amount=0 -> selfbalance)
  // ============================================================
  it("0x08: wrap WETH with explicit amount", async function () {
    const amount = ethers.parseEther("1");
    await owner.sendTransaction({ to: mev.target, value: amount });

    const payload = "0x08" + packAmount112(amount);

    const wethBalBefore = await weth.balanceOf(mev.target);
    await sendAndLog(operator, {
      to: mev.target,
      data: payload,
      value: BigInt(payload.substring(2).length / 2),
    }, this.test.title);
    const wethBalAfter = await weth.balanceOf(mev.target);
    expect(wethBalAfter - wethBalBefore).to.equal(amount);
  });

  it("0x08: wrap WETH adaptive (amount=0 -> selfbalance)", async function () {
    const amount = ethers.parseEther("2");
    await owner.sendTransaction({ to: mev.target, value: amount });

    // amount=0 triggers selfbalance()
    const payload = "0x08" + packAmount112(0n);

    const wethBalBefore = await weth.balanceOf(mev.target);
    const receipt = await sendAndLog(operator, {
      to: mev.target,
      data: payload,
      value: BigInt(payload.substring(2).length / 2),
    }, this.test.title);
    const wethBalAfter = await weth.balanceOf(mev.target);
    // Contract wraps all ETH balance (including the callvalue sent with the tx)
    expect(wethBalAfter - wethBalBefore).to.be.gte(amount);
  });

  // ============================================================
  // 0x0A: Unwrap WETH (adaptive: 14 bytes, amount=0 -> balanceOf(WETH))
  // ============================================================
  it("0x0A: unwrap WETH with explicit amount", async function () {
    const amount = ethers.parseEther("1");
    await weth.connect(owner).deposit({ value: amount });
    await weth.connect(owner).transfer(mev.target, amount);

    const payload = "0x0a" + packAmount112(amount);
    const wethBalBefore = await weth.balanceOf(mev.target);
    await sendAndLog(operator, {
      to: mev.target,
      data: payload,
      value: BigInt(payload.substring(2).length / 2),
    }, this.test.title);
    const wethBalAfter = await weth.balanceOf(mev.target);
    expect(wethBalBefore - wethBalAfter).to.equal(amount);
  });

  it("0x0A: unwrap WETH adaptive (amount=0 -> full WETH balance)", async function () {
    const amount = ethers.parseEther("1.5");
    await weth.connect(owner).deposit({ value: amount });
    await weth.connect(owner).transfer(mev.target, amount);

    // amount=0 triggers balanceOf(WETH, this)
    const payload = "0x0a" + packAmount112(0n);
    await sendAndLog(operator, {
      to: mev.target,
      data: payload,
      value: BigInt(payload.substring(2).length / 2),
    }, this.test.title);
    const wethBalAfter = await weth.balanceOf(mev.target);
    expect(wethBalAfter).to.equal(0n);
  });

  // ============================================================
  // 0x09: Bribe (unchanged from V1)
  // ============================================================
  it("0x09: bribe (coinbase transfer)", async function () {
    const amount = ethers.parseEther("0.01");
    await owner.sendTransaction({ to: mev.target, value: ethers.parseEther("1") });

    const coinbase = await ethers.provider.send("eth_coinbase", []);
    const coinbaseBalBefore = await ethers.provider.getBalance(coinbase);

    const payload = "0x09" + packAmount72(amount);
    await sendAndLog(operator, {
      to: mev.target,
      data: payload,
      value: BigInt(payload.substring(2).length / 2),
    }, this.test.title);

    const coinbaseBalAfter = await ethers.provider.getBalance(coinbase);
    expect(coinbaseBalAfter - coinbaseBalBefore).to.be.gte(amount);
  });

  // ============================================================
  // 0x0B: Transfer ETH
  // ============================================================
  it("0x0B: transfer ETH", async function () {
    const amount = ethers.parseEther("0.5");
    await owner.sendTransaction({ to: mev.target, value: ethers.parseEther("2") });

    const aliceBalBefore = await ethers.provider.getBalance(alice.address);
    const payload = "0x0b" + packAmount112(amount) + packAddress(alice.address);
    await sendAndLog(operator, {
      to: mev.target,
      data: payload,
      value: BigInt(payload.substring(2).length / 2),
    }, this.test.title);
    const aliceBalAfter = await ethers.provider.getBalance(alice.address);
    expect(aliceBalAfter - aliceBalBefore).to.equal(amount);
  });

  // ============================================================
  // 0x0C: Transfer ERC20
  // ============================================================
  it("0x0C: transfer ERC20", async function () {
    const amount = ethers.parseUnits("100", 18);
    await token.mint(mev.target, amount);

    const aliceBalBefore = await token.balanceOf(alice.address);
    const payload = "0x0c" + packAddress(token.target) + packAddress(alice.address) + packAmount112(amount);
    await sendAndLog(operator, {
      to: mev.target,
      data: payload,
      value: BigInt(payload.substring(2).length / 2),
    }, this.test.title);
    const aliceBalAfter = await token.balanceOf(alice.address);
    expect(aliceBalAfter - aliceBalBefore).to.equal(amount);
  });

  // ============================================================
  // 0x0D: Balance check
  // ============================================================
  it("0x0D: balance check — passes when balance sufficient", async function () {
    const mintAmount = ethers.parseUnits("1000", 18);
    await token.mint(owner.address, mintAmount);
    const bal = await token.balanceOf(owner.address);

    const payload = "0x0d" + packAddress(owner.address) + packAddress(token.target) + packAmount112(bal);
    await sendAndLog(operator, {
      to: mev.target,
      data: payload,
      value: BigInt(payload.substring(2).length / 2),
    }, this.test.title);
  });

  it("0x0D: balance check — reverts when balance insufficient", async function () {
    const bal = await token.balanceOf(owner.address);
    const checkAmount = bal + 1n;

    const payload = "0x0d" + packAddress(owner.address) + packAddress(token.target) + packAmount112(checkAmount);
    await expect(
      operator.sendTransaction(await withOperatorFee({
        to: mev.target,
        data: payload,
        value: BigInt(payload.substring(2).length / 2),
      }))
    ).to.be.reverted;
  });

  // ============================================================
  // 0x0E: Sweep (transfer entire token balance)
  // ============================================================
  it("0x0E: sweep — transfers entire token balance", async function () {
    const amount = ethers.parseUnits("500", 18);
    await token.mint(mev.target, amount);

    const aliceBalBefore = await token.balanceOf(alice.address);
    const mevBalBefore = await token.balanceOf(mev.target);

    // Layout: token(20) + to(20) = 40
    const payload = "0x0e" + packAddress(token.target) + packAddress(alice.address);
    const receipt = await sendAndLog(operator, {
      to: mev.target,
      data: payload,
      value: BigInt(payload.substring(2).length / 2),
    }, this.test.title);

    const aliceBalAfter = await token.balanceOf(alice.address);
    const mevBalAfter = await token.balanceOf(mev.target);

    expect(mevBalAfter).to.equal(0n);
    expect(aliceBalAfter - aliceBalBefore).to.equal(mevBalBefore);

    // Verify Transfer event
    const transfers = parseTransfers(receipt);
    const sweepXfer = transfers.find(t =>
      t.from.toLowerCase() === mev.target.toLowerCase() &&
      t.to.toLowerCase() === alice.address.toLowerCase()
    );
    expect(sweepXfer, "sweep Transfer must exist").to.exist;
    expect(sweepXfer.value).to.equal(mevBalBefore);
  });

  it("0x0E: sweep — no-op when balance is zero", async function () {
    // token2 not minted to mev
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const token2 = await MockERC20.deploy("Token2", "T2", 18);
    await token2.waitForDeployment();

    const payload = "0x0e" + packAddress(token2.target) + packAddress(alice.address);
    // Should not revert
    await sendAndLog(operator, {
      to: mev.target,
      data: payload,
      value: BigInt(payload.substring(2).length / 2),
    }, this.test.title);
  });

  // ============================================================
  // Multi-command: wrap + transfer
  // ============================================================
  it("multi-command: wrap WETH + transfer ERC20", async function () {
    const wrapAmount = ethers.parseEther("0.5");
    const transferAmount = ethers.parseUnits("50", 18);
    await token.mint(mev.target, transferAmount);

    const wethBalBefore = await weth.balanceOf(mev.target);
    const aliceTokenBefore = await token.balanceOf(alice.address);

    const cmd1 = "08" + packAmount112(wrapAmount);
    const cmd2 = "0c" + packAddress(token.target) + packAddress(alice.address) + packAmount112(transferAmount);
    const payload = "0x" + cmd1 + cmd2;

    await sendAndLog(operator, {
      to: mev.target,
      data: payload,
      value: BigInt(payload.substring(2).length / 2),
    }, this.test.title);

    const wethBalAfter = await weth.balanceOf(mev.target);
    const aliceTokenAfter = await token.balanceOf(alice.address);
    expect(wethBalAfter - wethBalBefore).to.equal(wrapAmount);
    expect(aliceTokenAfter - aliceTokenBefore).to.equal(transferAmount);
  });

  // ============================================================
  // 0x00/0x01: V2 ADAPTIVE SWAP (on-chain amountOut computation)
  // ============================================================
  describe("V2 adaptive swaps", function () {
    let v2Pair;
    let pairAddress;
    const WETH_LIQ = ethers.parseEther("10");
    const TOKEN_LIQ = ethers.parseUnits("10000", 18);

    before(async function () {
      const MockV2Pair = await ethers.getContractFactory("MockV2Pair");
      v2Pair = await MockV2Pair.deploy(WETH_ADDRESS, token.target, false);
      await v2Pair.waitForDeployment();
      pairAddress = v2Pair.target;

      await weth.connect(owner).deposit({ value: WETH_LIQ });
      await weth.connect(owner).transfer(pairAddress, WETH_LIQ);
      await token.mint(pairAddress, TOKEN_LIQ);
      await v2Pair.sync();
    });

    it("0x00: V2 adaptive zfo — explicit amount", async function () {
      const token0 = await v2Pair.token0();
      const token1 = await v2Pair.token1();
      const [reserve0, reserve1] = await v2Pair.getReserves();

      const amountIn = ethers.parseUnits("100", 18);
      // Expected: contract computes amountOut on-chain using fee_bps=30 (0.3%)
      const amountInWithFee = amountIn * (10000n - 30n);
      const expectedAmountOut = (amountInWithFee * reserve1) / (reserve0 * 10000n + amountInWithFee);

      // Fund MEV contract
      if (token0.toLowerCase() === WETH_ADDRESS.toLowerCase()) {
        await weth.connect(owner).deposit({ value: amountIn });
        await weth.connect(owner).transfer(mev.target, amountIn);
      } else {
        await token.mint(mev.target, amountIn);
      }

      // V2 adaptive: opcode(1) + selector(4) + fee_bps(2) + pair(20) + tokenIn(20) + amountIn(14) = 61
      const payload = "0x00" +
        V2_SWAP_SELECTOR +
        packFeeBps(30) +
        packAddress(pairAddress) +
        packAddress(token0) +
        packAmount112(amountIn);

      const mevToken1Before =
        token1.toLowerCase() === WETH_ADDRESS.toLowerCase()
          ? await weth.balanceOf(mev.target)
          : await token.balanceOf(mev.target);

      const receipt = await sendAndLog(operator, {
        to: mev.target,
        data: payload,
        value: BigInt(payload.substring(2).length / 2),
      }, this.test.title);

      const mevToken1After =
        token1.toLowerCase() === WETH_ADDRESS.toLowerCase()
          ? await weth.balanceOf(mev.target)
          : await token.balanceOf(mev.target);

      expect(mevToken1After - mevToken1Before).to.equal(expectedAmountOut);

      // Verify Transfer events
      const transfers = parseTransfers(receipt);
      const inputXfer = transfers.find(t =>
        t.from.toLowerCase() === mev.target.toLowerCase() &&
        t.to.toLowerCase() === pairAddress.toLowerCase() &&
        t.token === token0.toLowerCase()
      );
      expect(inputXfer, "MEV must Transfer token0 to pair").to.exist;
      expect(inputXfer.value).to.equal(amountIn);

      const outputXfer = transfers.find(t =>
        t.from.toLowerCase() === pairAddress.toLowerCase() &&
        t.to.toLowerCase() === mev.target.toLowerCase() &&
        t.token === token1.toLowerCase()
      );
      expect(outputXfer, "pair must Transfer token1 to MEV").to.exist;
      expect(outputXfer.value).to.equal(expectedAmountOut);
    });

    it("0x01: V2 adaptive ofz — explicit amount", async function () {
      const token0 = await v2Pair.token0();
      const token1 = await v2Pair.token1();
      const [reserve0, reserve1] = await v2Pair.getReserves();

      const amountIn = ethers.parseUnits("100", 18);
      // ofz: sell token1, get token0
      const amountInWithFee = amountIn * (10000n - 30n);
      const expectedAmountOut = (amountInWithFee * reserve0) / (reserve1 * 10000n + amountInWithFee);

      if (token1.toLowerCase() === WETH_ADDRESS.toLowerCase()) {
        await weth.connect(owner).deposit({ value: amountIn });
        await weth.connect(owner).transfer(mev.target, amountIn);
      } else {
        await token.mint(mev.target, amountIn);
      }

      const payload = "0x01" +
        V2_SWAP_SELECTOR +
        packFeeBps(30) +
        packAddress(pairAddress) +
        packAddress(token1) +
        packAmount112(amountIn);

      const mevToken0Before =
        token0.toLowerCase() === WETH_ADDRESS.toLowerCase()
          ? await weth.balanceOf(mev.target)
          : await token.balanceOf(mev.target);

      const receipt = await sendAndLog(operator, {
        to: mev.target,
        data: payload,
        value: BigInt(payload.substring(2).length / 2),
      }, this.test.title);

      const mevToken0After =
        token0.toLowerCase() === WETH_ADDRESS.toLowerCase()
          ? await weth.balanceOf(mev.target)
          : await token.balanceOf(mev.target);

      expect(mevToken0After - mevToken0Before).to.equal(expectedAmountOut);

      // Verify Transfer events
      const transfers = parseTransfers(receipt);
      const inputXfer = transfers.find(t =>
        t.from.toLowerCase() === mev.target.toLowerCase() &&
        t.to.toLowerCase() === pairAddress.toLowerCase() &&
        t.token === token1.toLowerCase()
      );
      expect(inputXfer, "MEV must Transfer token1 to pair").to.exist;
      expect(inputXfer.value).to.equal(amountIn);

      const outputXfer = transfers.find(t =>
        t.from.toLowerCase() === pairAddress.toLowerCase() &&
        t.to.toLowerCase() === mev.target.toLowerCase() &&
        t.token === token0.toLowerCase()
      );
      expect(outputXfer, "pair must Transfer token0 to MEV").to.exist;
      expect(outputXfer.value).to.equal(expectedAmountOut);
    });

    it("0x00: V2 adaptive zfo — amount=0 (balanceOf fallback)", async function () {
      const token0 = await v2Pair.token0();
      const token1 = await v2Pair.token1();

      const mintAmount = ethers.parseUnits("50", 18);

      // Fund MEV contract
      if (token0.toLowerCase() === WETH_ADDRESS.toLowerCase()) {
        await weth.connect(owner).deposit({ value: mintAmount });
        await weth.connect(owner).transfer(mev.target, mintAmount);
      } else {
        await token.mint(mev.target, mintAmount);
      }

      // Read ACTUAL balance (may include leftover from previous tests)
      const actualBalance = token0.toLowerCase() === WETH_ADDRESS.toLowerCase()
        ? await weth.balanceOf(mev.target)
        : await token.balanceOf(mev.target);

      // Read reserves and compute expected output using actual balance
      const [reserve0, reserve1] = await v2Pair.getReserves();
      const amountInWithFee = actualBalance * (10000n - 30n);
      const expectedAmountOut = (amountInWithFee * reserve1) / (reserve0 * 10000n + amountInWithFee);

      // amount_in = 0 -> contract reads balanceOf(this, tokenIn)
      const payload = "0x00" +
        V2_SWAP_SELECTOR +
        packFeeBps(30) +
        packAddress(pairAddress) +
        packAddress(token0) +
        packAmount112(0n);

      const mevToken1Before =
        token1.toLowerCase() === WETH_ADDRESS.toLowerCase()
          ? await weth.balanceOf(mev.target)
          : await token.balanceOf(mev.target);

      const receipt = await sendAndLog(operator, {
        to: mev.target,
        data: payload,
        value: BigInt(payload.substring(2).length / 2),
      }, this.test.title);

      const mevToken1After =
        token1.toLowerCase() === WETH_ADDRESS.toLowerCase()
          ? await weth.balanceOf(mev.target)
          : await token.balanceOf(mev.target);

      // Output should match expected (contract reads balanceOf and uses that as amountIn)
      expect(mevToken1After - mevToken1Before).to.equal(expectedAmountOut);

      // Verify Transfer events
      const transfers = parseTransfers(receipt);
      const inputXfer = transfers.find(t =>
        t.from.toLowerCase() === mev.target.toLowerCase() &&
        t.to.toLowerCase() === pairAddress.toLowerCase() &&
        t.token === token0.toLowerCase()
      );
      expect(inputXfer, "MEV must Transfer token0 to pair").to.exist;
      expect(inputXfer.value).to.equal(actualBalance);
    });

    it("0x01: V2 adaptive ofz — amount=0 (balanceOf fallback)", async function () {
      const token0 = await v2Pair.token0();
      const token1 = await v2Pair.token1();

      const mintAmount = ethers.parseUnits("50", 18);

      // Fund MEV with token1
      if (token1.toLowerCase() === WETH_ADDRESS.toLowerCase()) {
        await weth.connect(owner).deposit({ value: mintAmount });
        await weth.connect(owner).transfer(mev.target, mintAmount);
      } else {
        await token.mint(mev.target, mintAmount);
      }

      // Read ACTUAL balance
      const actualBalance = token1.toLowerCase() === WETH_ADDRESS.toLowerCase()
        ? await weth.balanceOf(mev.target)
        : await token.balanceOf(mev.target);

      // ofz: sell token1, get token0
      const [reserve0, reserve1] = await v2Pair.getReserves();
      const amountInWithFee = actualBalance * (10000n - 30n);
      const expectedAmountOut = (amountInWithFee * reserve0) / (reserve1 * 10000n + amountInWithFee);

      const payload = "0x01" +
        V2_SWAP_SELECTOR +
        packFeeBps(30) +
        packAddress(pairAddress) +
        packAddress(token1) +
        packAmount112(0n); // balanceOf fallback

      const mevToken0Before =
        token0.toLowerCase() === WETH_ADDRESS.toLowerCase()
          ? await weth.balanceOf(mev.target)
          : await token.balanceOf(mev.target);

      const receipt = await sendAndLog(operator, {
        to: mev.target,
        data: payload,
        value: BigInt(payload.substring(2).length / 2),
      }, this.test.title);

      const mevToken0After =
        token0.toLowerCase() === WETH_ADDRESS.toLowerCase()
          ? await weth.balanceOf(mev.target)
          : await token.balanceOf(mev.target);

      expect(mevToken0After - mevToken0Before).to.equal(expectedAmountOut);

      // Verify Transfer events
      const transfers = parseTransfers(receipt);
      const inputXfer = transfers.find(t =>
        t.from.toLowerCase() === mev.target.toLowerCase() &&
        t.to.toLowerCase() === pairAddress.toLowerCase() &&
        t.token === token1.toLowerCase()
      );
      expect(inputXfer, "MEV must Transfer token1 to pair").to.exist;
      expect(inputXfer.value).to.equal(actualBalance);
    });

    it("0x00: V2 adaptive with custom fee (25 bps = PancakeSwap)", async function () {
      // Deploy MockV2PairWithFee with 25 bps fee
      const MockV2PairWithFee = await ethers.getContractFactory("MockV2PairWithFee");
      const customPair = await MockV2PairWithFee.deploy(WETH_ADDRESS, token.target, 25);
      await customPair.waitForDeployment();
      const customPairAddr = customPair.target;

      const wethLiq = ethers.parseEther("5");
      const tokenLiq = ethers.parseUnits("5000", 18);
      await weth.connect(owner).deposit({ value: wethLiq });
      await weth.connect(owner).transfer(customPairAddr, wethLiq);
      await token.mint(customPairAddr, tokenLiq);
      await customPair.sync();

      const token0 = await customPair.token0();
      const token1 = await customPair.token1();
      const [reserve0, reserve1] = await customPair.getReserves();

      const amountIn = ethers.parseUnits("10", 18);
      // fee = 25 bps
      const amountInWithFee = amountIn * (10000n - 25n);
      const expectedAmountOut = (amountInWithFee * reserve1) / (reserve0 * 10000n + amountInWithFee);

      if (token0.toLowerCase() === WETH_ADDRESS.toLowerCase()) {
        await weth.connect(owner).deposit({ value: amountIn });
        await weth.connect(owner).transfer(mev.target, amountIn);
      } else {
        await token.mint(mev.target, amountIn);
      }

      const payload = "0x00" +
        V2_SWAP_SELECTOR +
        packFeeBps(25) +
        packAddress(customPairAddr) +
        packAddress(token0) +
        packAmount112(amountIn);

      const mevToken1Before =
        token1.toLowerCase() === WETH_ADDRESS.toLowerCase()
          ? await weth.balanceOf(mev.target)
          : await token.balanceOf(mev.target);

      const receipt = await sendAndLog(operator, {
        to: mev.target,
        data: payload,
        value: BigInt(payload.substring(2).length / 2),
      }, this.test.title);

      const mevToken1After =
        token1.toLowerCase() === WETH_ADDRESS.toLowerCase()
          ? await weth.balanceOf(mev.target)
          : await token.balanceOf(mev.target);

      expect(mevToken1After - mevToken1Before).to.equal(expectedAmountOut);
    });
  });

  // ============================================================
  // 0x02/0x03: V3 swaps (with balanceOf fallback)
  // ============================================================
  describe("V3 swaps", function () {
    let poolAddress;
    let v3Token0, v3Token1;
    const FEE = 3000;
    const UNI_V3_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
    const POOL_INIT_CODE_HASH = "0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54";

    before(async function () {
      if (BigInt(WETH_ADDRESS) < BigInt(token.target)) {
        v3Token0 = WETH_ADDRESS;
        v3Token1 = token.target;
      } else {
        v3Token0 = token.target;
        v3Token1 = WETH_ADDRESS;
      }

      const salt = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "address", "uint24"],
          [v3Token0, v3Token1, FEE]
        )
      );
      poolAddress = ethers.getCreate2Address(UNI_V3_FACTORY, salt, POOL_INIT_CODE_HASH);

      const MockV3Pool = await ethers.getContractFactory("MockV3Pool");
      const tempPool = await MockV3Pool.deploy(v3Token0, v3Token1, FEE, false);
      await tempPool.waitForDeployment();
      const poolCode = await ethers.provider.getCode(tempPool.target);
      await ethers.provider.send("hardhat_setCode", [poolAddress, poolCode]);

      const fundAmount = ethers.parseEther("100");
      await weth.connect(owner).deposit({ value: fundAmount });
      await weth.connect(owner).transfer(poolAddress, fundAmount);
      await token.mint(poolAddress, ethers.parseUnits("100000", 18));
    });

    it("0x02: V3 swap zfo — explicit amount", async function () {
      const amountIn = ethers.parseUnits("0.1", 18);

      if (v3Token0.toLowerCase() === WETH_ADDRESS.toLowerCase()) {
        await weth.connect(owner).deposit({ value: amountIn });
        await weth.connect(owner).transfer(mev.target, amountIn);
      } else {
        await token.mint(mev.target, amountIn);
      }

      const payload = "0x02" +
        V3_SWAP_SELECTOR +
        packAddress(v3Token0) +
        packAddress(v3Token1) +
        packAddress(poolAddress) +
        packAmount112(amountIn);

      const mevBefore =
        v3Token1.toLowerCase() === WETH_ADDRESS.toLowerCase()
          ? await weth.balanceOf(mev.target)
          : await token.balanceOf(mev.target);

      const receipt = await sendAndLog(operator, {
        to: mev.target,
        data: payload,
        value: BigInt(payload.substring(2).length / 2),
      }, this.test.title);

      const mevAfter =
        v3Token1.toLowerCase() === WETH_ADDRESS.toLowerCase()
          ? await weth.balanceOf(mev.target)
          : await token.balanceOf(mev.target);

      expect(mevAfter).to.be.gt(mevBefore);

      const transfers = parseTransfers(receipt);
      const inputXfer = transfers.find(t =>
        t.from.toLowerCase() === mev.target.toLowerCase() &&
        t.to.toLowerCase() === poolAddress.toLowerCase() &&
        t.token === v3Token0.toLowerCase()
      );
      expect(inputXfer, "MEV must Transfer token0 to pool").to.exist;
    });

    it("0x02: V3 swap zfo — amount=0 (balanceOf fallback)", async function () {
      const amountIn = ethers.parseUnits("0.05", 18);

      if (v3Token0.toLowerCase() === WETH_ADDRESS.toLowerCase()) {
        await weth.connect(owner).deposit({ value: amountIn });
        await weth.connect(owner).transfer(mev.target, amountIn);
      } else {
        await token.mint(mev.target, amountIn);
      }

      // amount=0 -> contract reads balanceOf
      const payload = "0x02" +
        V3_SWAP_SELECTOR +
        packAddress(v3Token0) +
        packAddress(v3Token1) +
        packAddress(poolAddress) +
        packAmount112(0n);

      const mevBefore =
        v3Token1.toLowerCase() === WETH_ADDRESS.toLowerCase()
          ? await weth.balanceOf(mev.target)
          : await token.balanceOf(mev.target);

      await sendAndLog(operator, {
        to: mev.target,
        data: payload,
        value: BigInt(payload.substring(2).length / 2),
      }, this.test.title);

      const mevAfter =
        v3Token1.toLowerCase() === WETH_ADDRESS.toLowerCase()
          ? await weth.balanceOf(mev.target)
          : await token.balanceOf(mev.target);

      expect(mevAfter).to.be.gt(mevBefore);
    });

    it("0x03: V3 swap ofz — amount=0 (balanceOf fallback)", async function () {
      const amountIn = ethers.parseUnits("0.05", 18);

      if (v3Token1.toLowerCase() === WETH_ADDRESS.toLowerCase()) {
        await weth.connect(owner).deposit({ value: amountIn });
        await weth.connect(owner).transfer(mev.target, amountIn);
      } else {
        await token.mint(mev.target, amountIn);
      }

      // amount=0 -> contract reads balanceOf
      const payload = "0x03" +
        V3_SWAP_SELECTOR +
        packAddress(v3Token0) +
        packAddress(v3Token1) +
        packAddress(poolAddress) +
        packAmount112(0n);

      const mevBefore =
        v3Token0.toLowerCase() === WETH_ADDRESS.toLowerCase()
          ? await weth.balanceOf(mev.target)
          : await token.balanceOf(mev.target);

      await sendAndLog(operator, {
        to: mev.target,
        data: payload,
        value: BigInt(payload.substring(2).length / 2),
      }, this.test.title);

      const mevAfter =
        v3Token0.toLowerCase() === WETH_ADDRESS.toLowerCase()
          ? await weth.balanceOf(mev.target)
          : await token.balanceOf(mev.target);

      expect(mevAfter).to.be.gt(mevBefore);
    });

    it("0x03: V3 swap ofz — explicit amount", async function () {
      const amountIn = ethers.parseUnits("0.1", 18);

      if (v3Token1.toLowerCase() === WETH_ADDRESS.toLowerCase()) {
        await weth.connect(owner).deposit({ value: amountIn });
        await weth.connect(owner).transfer(mev.target, amountIn);
      } else {
        await token.mint(mev.target, amountIn);
      }

      const payload = "0x03" +
        V3_SWAP_SELECTOR +
        packAddress(v3Token0) +
        packAddress(v3Token1) +
        packAddress(poolAddress) +
        packAmount112(amountIn);

      const mevBefore =
        v3Token0.toLowerCase() === WETH_ADDRESS.toLowerCase()
          ? await weth.balanceOf(mev.target)
          : await token.balanceOf(mev.target);

      const receipt = await sendAndLog(operator, {
        to: mev.target,
        data: payload,
        value: BigInt(payload.substring(2).length / 2),
      }, this.test.title);

      const mevAfter =
        v3Token0.toLowerCase() === WETH_ADDRESS.toLowerCase()
          ? await weth.balanceOf(mev.target)
          : await token.balanceOf(mev.target);

      expect(mevAfter).to.be.gt(mevBefore);
    });
  });

  // ============================================================
  // 0x04/0x05: Balancer V2 swaps (with balanceOf fallback)
  // ============================================================
  describe("Balancer V2 swaps", function () {
    let token2;

    before(async function () {
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      token2 = await MockERC20.deploy("Balancer Token", "BAL", 18);
      await token2.waitForDeployment();

      // Deploy mock vault at the expected address
      const MockBalancerVault = await ethers.getContractFactory("MockBalancerVault");
      const tempVault = await MockBalancerVault.deploy();
      await tempVault.waitForDeployment();
      const vaultCode = await ethers.provider.getCode(tempVault.target);
      await ethers.provider.send("hardhat_setCode", [BALANCER_VAULT_ADDRESS, vaultCode]);

      // Fund vault with tokens
      await token.mint(BALANCER_VAULT_ADDRESS, ethers.parseUnits("100000", 18));
      await token2.mint(BALANCER_VAULT_ADDRESS, ethers.parseUnits("100000", 18));
    });

    it("0x04: Balancer V2 zfo — explicit amount", async function () {
      const amountIn = ethers.parseUnits("100", 18);
      await token.mint(mev.target, amountIn);

      const poolId = ethers.keccak256(ethers.toUtf8Bytes("test-pool-1"));

      // Payload: selector(4) + vault(20) + poolId(32) + token0(20) + token1(20) + amount(14) = 110
      const payload = "0x04" +
        BAL_SWAP_SELECTOR +
        packAddress(BALANCER_VAULT_ADDRESS) +
        poolId.slice(2) +
        packAddress(token.target) +
        packAddress(token2.target) +
        packAmount112(amountIn);

      const mevBefore = await token2.balanceOf(mev.target);
      const receipt = await sendAndLog(operator, {
        to: mev.target,
        data: payload,
        value: BigInt(payload.substring(2).length / 2),
      }, this.test.title);
      const mevAfter = await token2.balanceOf(mev.target);
      expect(mevAfter).to.be.gt(mevBefore);
    });

    it("0x05: Balancer V2 ofz — explicit amount", async function () {
      const amountIn = ethers.parseUnits("100", 18);
      await token2.mint(mev.target, amountIn);

      const poolId = ethers.keccak256(ethers.toUtf8Bytes("test-pool-3"));

      // ofz: token1(=token2) as input, token0(=token) as output
      // Layout same as zfo: selector(4) + vault(20) + poolId(32) + token0(20) + token1(20) + amount(14)
      const payload = "0x05" +
        BAL_SWAP_SELECTOR +
        packAddress(BALANCER_VAULT_ADDRESS) +
        poolId.slice(2) +
        packAddress(token.target) +
        packAddress(token2.target) +
        packAmount112(amountIn);

      const mevBefore = await token.balanceOf(mev.target);
      const receipt = await sendAndLog(operator, {
        to: mev.target,
        data: payload,
        value: BigInt(payload.substring(2).length / 2),
      }, this.test.title);
      const mevAfter = await token.balanceOf(mev.target);
      expect(mevAfter).to.be.gt(mevBefore);
    });

    it("0x05: Balancer V2 ofz — amount=0 (balanceOf fallback)", async function () {
      const amountIn = ethers.parseUnits("50", 18);
      await token2.mint(mev.target, amountIn);

      const poolId = ethers.keccak256(ethers.toUtf8Bytes("test-pool-4"));

      const payload = "0x05" +
        BAL_SWAP_SELECTOR +
        packAddress(BALANCER_VAULT_ADDRESS) +
        poolId.slice(2) +
        packAddress(token.target) +
        packAddress(token2.target) +
        packAmount112(0n); // balanceOf fallback

      const mevBefore = await token.balanceOf(mev.target);
      await sendAndLog(operator, {
        to: mev.target,
        data: payload,
        value: BigInt(payload.substring(2).length / 2),
      }, this.test.title);
      const mevAfter = await token.balanceOf(mev.target);
      expect(mevAfter).to.be.gt(mevBefore);
    });

    it("0x04: Balancer V2 zfo — amount=0 (balanceOf fallback)", async function () {
      const amountIn = ethers.parseUnits("50", 18);
      await token.mint(mev.target, amountIn);

      const poolId = ethers.keccak256(ethers.toUtf8Bytes("test-pool-2"));

      const payload = "0x04" +
        BAL_SWAP_SELECTOR +
        packAddress(BALANCER_VAULT_ADDRESS) +
        poolId.slice(2) +
        packAddress(token.target) +
        packAddress(token2.target) +
        packAmount112(0n); // balanceOf fallback

      const mevBefore = await token2.balanceOf(mev.target);
      await sendAndLog(operator, {
        to: mev.target,
        data: payload,
        value: BigInt(payload.substring(2).length / 2),
      }, this.test.title);
      const mevAfter = await token2.balanceOf(mev.target);
      expect(mevAfter).to.be.gt(mevBefore);
    });
  });

  // ============================================================
  // 0x06/0x07: Curve swaps (with balanceOf fallback)
  // ============================================================
  describe("Curve swaps", function () {
    let curvePool;
    let token2;

    before(async function () {
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      token2 = await MockERC20.deploy("Curve Token", "CRV", 18);
      await token2.waitForDeployment();

      const MockCurvePool = await ethers.getContractFactory("MockCurvePool");
      curvePool = await MockCurvePool.deploy([token.target, token2.target]);
      await curvePool.waitForDeployment();

      // Fund pool
      await token.mint(curvePool.target, ethers.parseUnits("100000", 18));
      await token2.mint(curvePool.target, ethers.parseUnits("100000", 18));
    });

    it("0x06: Curve zfo — explicit amount", async function () {
      const amountIn = ethers.parseUnits("100", 18);
      await token.mint(mev.target, amountIn);

      // idx0=0, idx1=1
      const idx0Hex = "000000000000"; // 6 bytes
      const idx1Hex = "000000000001"; // 6 bytes

      const payload = "0x06" +
        CURVE_STABLE_SELECTOR +
        packAddress(curvePool.target) +
        idx0Hex + idx1Hex +
        packAddress(token.target) +
        packAmount112(amountIn);

      const mevBefore = await token2.balanceOf(mev.target);
      const receipt = await sendAndLog(operator, {
        to: mev.target,
        data: payload,
        value: BigInt(payload.substring(2).length / 2),
      }, this.test.title);
      const mevAfter = await token2.balanceOf(mev.target);
      expect(mevAfter).to.be.gt(mevBefore);

      const transfers = parseTransfers(receipt);
      const outputXfer = transfers.find(t =>
        t.to.toLowerCase() === mev.target.toLowerCase() &&
        t.token === token2.target.toLowerCase()
      );
      expect(outputXfer, "Curve must Transfer output to MEV").to.exist;
    });

    it("0x07: Curve ofz — explicit amount", async function () {
      const amountIn = ethers.parseUnits("100", 18);
      await token2.mint(mev.target, amountIn);

      // ofz: sell token2 (idx1=1), buy token (idx0=0)
      // Layout same as zfo: selector(4) + pool(20) + idx0(6) + idx1(6) + tokenIn(20) + amountIn(14)
      const idx0Hex = "000000000000"; // buy index
      const idx1Hex = "000000000001"; // sell index

      const payload = "0x07" +
        CURVE_STABLE_SELECTOR +
        packAddress(curvePool.target) +
        idx0Hex + idx1Hex +
        packAddress(token2.target) +
        packAmount112(amountIn);

      const mevBefore = await token.balanceOf(mev.target);
      const receipt = await sendAndLog(operator, {
        to: mev.target,
        data: payload,
        value: BigInt(payload.substring(2).length / 2),
      }, this.test.title);
      const mevAfter = await token.balanceOf(mev.target);
      expect(mevAfter).to.be.gt(mevBefore);

      const transfers = parseTransfers(receipt);
      const outputXfer = transfers.find(t =>
        t.to.toLowerCase() === mev.target.toLowerCase() &&
        t.token === token.target.toLowerCase()
      );
      expect(outputXfer, "Curve must Transfer output to MEV").to.exist;
    });

    it("0x07: Curve ofz — amount=0 (balanceOf fallback)", async function () {
      const amountIn = ethers.parseUnits("50", 18);
      await token2.mint(mev.target, amountIn);

      const idx0Hex = "000000000000";
      const idx1Hex = "000000000001";

      const payload = "0x07" +
        CURVE_STABLE_SELECTOR +
        packAddress(curvePool.target) +
        idx0Hex + idx1Hex +
        packAddress(token2.target) +
        packAmount112(0n); // balanceOf fallback

      const mevBefore = await token.balanceOf(mev.target);
      await sendAndLog(operator, {
        to: mev.target,
        data: payload,
        value: BigInt(payload.substring(2).length / 2),
      }, this.test.title);
      const mevAfter = await token.balanceOf(mev.target);
      expect(mevAfter).to.be.gt(mevBefore);
    });

    it("0x06: Curve zfo — amount=0 (balanceOf fallback)", async function () {
      const amountIn = ethers.parseUnits("50", 18);
      await token.mint(mev.target, amountIn);

      const idx0Hex = "000000000000";
      const idx1Hex = "000000000001";

      const payload = "0x06" +
        CURVE_STABLE_SELECTOR +
        packAddress(curvePool.target) +
        idx0Hex + idx1Hex +
        packAddress(token.target) +
        packAmount112(0n); // balanceOf fallback

      const mevBefore = await token2.balanceOf(mev.target);
      await sendAndLog(operator, {
        to: mev.target,
        data: payload,
        value: BigInt(payload.substring(2).length / 2),
      }, this.test.title);
      const mevAfter = await token2.balanceOf(mev.target);
      expect(mevAfter).to.be.gt(mevBefore);
    });
  });

  // ============================================================
  // 0x19/0x1A: Balancer V1 swaps (with balanceOf fallback)
  // ============================================================
  describe("Balancer V1 swaps", function () {
    let balV1Pool;
    let token2;

    before(async function () {
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      token2 = await MockERC20.deploy("BalV1 Token", "BV1", 18);
      await token2.waitForDeployment();

      const MockBalancerV1Pool = await ethers.getContractFactory("MockBalancerV1Pool");
      balV1Pool = await MockBalancerV1Pool.deploy(token.target, token2.target);
      await balV1Pool.waitForDeployment();

      // Fund pool
      await token.mint(balV1Pool.target, ethers.parseUnits("100000", 18));
      await token2.mint(balV1Pool.target, ethers.parseUnits("100000", 18));
    });

    it("0x19: Balancer V1 zfo — explicit amount", async function () {
      const amountIn = ethers.parseUnits("100", 18);
      await token.mint(mev.target, amountIn);

      const payload = "0x19" +
        BAL_V1_SWAP_SELECTOR +
        packAddress(balV1Pool.target) +
        packAddress(token.target) +
        packAddress(token2.target) +
        packAmount112(amountIn);

      const mevBefore = await token2.balanceOf(mev.target);
      await sendAndLog(operator, {
        to: mev.target,
        data: payload,
        value: BigInt(payload.substring(2).length / 2),
      }, this.test.title);
      const mevAfter = await token2.balanceOf(mev.target);
      expect(mevAfter).to.be.gt(mevBefore);
    });

    it("0x1A: Balancer V1 ofz — explicit amount", async function () {
      const amountIn = ethers.parseUnits("100", 18);
      await token2.mint(mev.target, amountIn);

      // ofz layout: selector(4) + pool(20) + tokenOut(20) + tokenIn(20) + amount(14) = 78
      const payload = "0x1a" +
        BAL_V1_SWAP_SELECTOR +
        packAddress(balV1Pool.target) +
        packAddress(token.target) +
        packAddress(token2.target) +
        packAmount112(amountIn);

      const mevBefore = await token.balanceOf(mev.target);
      await sendAndLog(operator, {
        to: mev.target,
        data: payload,
        value: BigInt(payload.substring(2).length / 2),
      }, this.test.title);
      const mevAfter = await token.balanceOf(mev.target);
      expect(mevAfter).to.be.gt(mevBefore);
    });

    it("0x1A: Balancer V1 ofz — amount=0 (balanceOf fallback)", async function () {
      const amountIn = ethers.parseUnits("50", 18);
      await token2.mint(mev.target, amountIn);

      const payload = "0x1a" +
        BAL_V1_SWAP_SELECTOR +
        packAddress(balV1Pool.target) +
        packAddress(token.target) +
        packAddress(token2.target) +
        packAmount112(0n); // balanceOf fallback

      const mevBefore = await token.balanceOf(mev.target);
      await sendAndLog(operator, {
        to: mev.target,
        data: payload,
        value: BigInt(payload.substring(2).length / 2),
      }, this.test.title);
      const mevAfter = await token.balanceOf(mev.target);
      expect(mevAfter).to.be.gt(mevBefore);
    });

    it("0x19: Balancer V1 zfo — amount=0 (balanceOf fallback)", async function () {
      const amountIn = ethers.parseUnits("50", 18);
      await token.mint(mev.target, amountIn);

      const payload = "0x19" +
        BAL_V1_SWAP_SELECTOR +
        packAddress(balV1Pool.target) +
        packAddress(token.target) +
        packAddress(token2.target) +
        packAmount112(0n);

      const mevBefore = await token2.balanceOf(mev.target);
      await sendAndLog(operator, {
        to: mev.target,
        data: payload,
        value: BigInt(payload.substring(2).length / 2),
      }, this.test.title);
      const mevAfter = await token2.balanceOf(mev.target);
      expect(mevAfter).to.be.gt(mevBefore);
    });
  });

  // ============================================================
  // 0x1B/0x1C: Fluid DEX swaps (with balanceOf fallback)
  // ============================================================
  describe("Fluid DEX swaps", function () {
    let fluidPool;
    let token2;

    before(async function () {
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      token2 = await MockERC20.deploy("Fluid Token", "FLD", 18);
      await token2.waitForDeployment();

      const MockFluidPool = await ethers.getContractFactory("MockFluidPool");
      fluidPool = await MockFluidPool.deploy(token.target, token2.target);
      await fluidPool.waitForDeployment();

      // Fund pool
      await token.mint(fluidPool.target, ethers.parseUnits("100000", 18));
      await token2.mint(fluidPool.target, ethers.parseUnits("100000", 18));
    });

    it("0x1B: Fluid zfo — explicit amount", async function () {
      const amountIn = ethers.parseUnits("100", 18);
      await token.mint(mev.target, amountIn);

      const payload = "0x1b" +
        FLUID_SWAP_SELECTOR +
        packAddress(fluidPool.target) +
        packAddress(token.target) +
        packAmount112(amountIn);

      const mevBefore = await token2.balanceOf(mev.target);
      await sendAndLog(operator, {
        to: mev.target,
        data: payload,
        value: BigInt(payload.substring(2).length / 2),
      }, this.test.title);
      const mevAfter = await token2.balanceOf(mev.target);
      expect(mevAfter).to.be.gt(mevBefore);
    });

    it("0x1C: Fluid ofz — explicit amount", async function () {
      const amountIn = ethers.parseUnits("100", 18);
      await token2.mint(mev.target, amountIn);

      // ofz: tokenIn=token2, swap1to0
      const payload = "0x1c" +
        FLUID_SWAP_SELECTOR +
        packAddress(fluidPool.target) +
        packAddress(token2.target) +
        packAmount112(amountIn);

      const mevBefore = await token.balanceOf(mev.target);
      await sendAndLog(operator, {
        to: mev.target,
        data: payload,
        value: BigInt(payload.substring(2).length / 2),
      }, this.test.title);
      const mevAfter = await token.balanceOf(mev.target);
      expect(mevAfter).to.be.gt(mevBefore);
    });

    it("0x1C: Fluid ofz — amount=0 (balanceOf fallback)", async function () {
      const amountIn = ethers.parseUnits("50", 18);
      await token2.mint(mev.target, amountIn);

      const payload = "0x1c" +
        FLUID_SWAP_SELECTOR +
        packAddress(fluidPool.target) +
        packAddress(token2.target) +
        packAmount112(0n); // balanceOf fallback

      const mevBefore = await token.balanceOf(mev.target);
      await sendAndLog(operator, {
        to: mev.target,
        data: payload,
        value: BigInt(payload.substring(2).length / 2),
      }, this.test.title);
      const mevAfter = await token.balanceOf(mev.target);
      expect(mevAfter).to.be.gt(mevBefore);
    });

    it("0x1B: Fluid zfo — amount=0 (balanceOf fallback)", async function () {
      const amountIn = ethers.parseUnits("50", 18);
      await token.mint(mev.target, amountIn);

      const payload = "0x1b" +
        FLUID_SWAP_SELECTOR +
        packAddress(fluidPool.target) +
        packAddress(token.target) +
        packAmount112(0n);

      const mevBefore = await token2.balanceOf(mev.target);
      await sendAndLog(operator, {
        to: mev.target,
        data: payload,
        value: BigInt(payload.substring(2).length / 2),
      }, this.test.title);
      const mevAfter = await token2.balanceOf(mev.target);
      expect(mevAfter).to.be.gt(mevBefore);
    });
  });

  // ============================================================
  // 0x1D/0x1E: DODO V2 swaps (with balanceOf fallback)
  // ============================================================
  describe("DODO V2 swaps", function () {
    let dodoPool;
    let token2;

    before(async function () {
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      token2 = await MockERC20.deploy("DODO Token", "DODO", 18);
      await token2.waitForDeployment();

      const MockDodoPool = await ethers.getContractFactory("MockDodoPool");
      dodoPool = await MockDodoPool.deploy(token.target, token2.target);
      await dodoPool.waitForDeployment();

      // Fund pool and sync
      await token.mint(dodoPool.target, ethers.parseUnits("100000", 18));
      await token2.mint(dodoPool.target, ethers.parseUnits("100000", 18));
      await dodoPool.sync();
    });

    it("0x1D: DODO zfo — explicit amount", async function () {
      const amountIn = ethers.parseUnits("100", 18);
      await token.mint(mev.target, amountIn);

      const payload = "0x1d" +
        DODO_SELL_BASE_SELECTOR +
        packAddress(dodoPool.target) +
        packAddress(token.target) +
        packAmount112(amountIn);

      const mevBefore = await token2.balanceOf(mev.target);
      await sendAndLog(operator, {
        to: mev.target,
        data: payload,
        value: BigInt(payload.substring(2).length / 2),
      }, this.test.title);
      const mevAfter = await token2.balanceOf(mev.target);
      expect(mevAfter).to.be.gt(mevBefore);
    });

    it("0x1E: DODO ofz — explicit amount", async function () {
      const amountIn = ethers.parseUnits("100", 18);
      await token2.mint(mev.target, amountIn);

      // ofz: tokenIn=token2 (quote token), uses sellQuote selector
      const payload = "0x1e" +
        DODO_SELL_QUOTE_SELECTOR +
        packAddress(dodoPool.target) +
        packAddress(token2.target) +
        packAmount112(amountIn);

      const mevBefore = await token.balanceOf(mev.target);
      await sendAndLog(operator, {
        to: mev.target,
        data: payload,
        value: BigInt(payload.substring(2).length / 2),
      }, this.test.title);
      const mevAfter = await token.balanceOf(mev.target);
      expect(mevAfter).to.be.gt(mevBefore);
    });

    it("0x1E: DODO ofz — amount=0 (balanceOf fallback)", async function () {
      const amountIn = ethers.parseUnits("50", 18);
      await token2.mint(mev.target, amountIn);

      const payload = "0x1e" +
        DODO_SELL_QUOTE_SELECTOR +
        packAddress(dodoPool.target) +
        packAddress(token2.target) +
        packAmount112(0n); // balanceOf fallback

      const mevBefore = await token.balanceOf(mev.target);
      await sendAndLog(operator, {
        to: mev.target,
        data: payload,
        value: BigInt(payload.substring(2).length / 2),
      }, this.test.title);
      const mevAfter = await token.balanceOf(mev.target);
      expect(mevAfter).to.be.gt(mevBefore);
    });

    it("0x1D: DODO zfo — amount=0 (balanceOf fallback)", async function () {
      const amountIn = ethers.parseUnits("50", 18);
      await token.mint(mev.target, amountIn);

      const payload = "0x1d" +
        DODO_SELL_BASE_SELECTOR +
        packAddress(dodoPool.target) +
        packAddress(token.target) +
        packAmount112(0n);

      const mevBefore = await token2.balanceOf(mev.target);
      await sendAndLog(operator, {
        to: mev.target,
        data: payload,
        value: BigInt(payload.substring(2).length / 2),
      }, this.test.title);
      const mevAfter = await token2.balanceOf(mev.target);
      expect(mevAfter).to.be.gt(mevBefore);
    });
  });

  // ============================================================
  // Flash chain tests: V2 flash, V3 flash swap, multi-hop
  // ============================================================
  describe("Flash chain: V2 flash arb (2-hop)", function () {
    let flashPair, tradePair;
    let flashPairAddr, tradePairAddr;
    let snapshot;

    before(async function () {
      snapshot = await ethers.provider.send("evm_snapshot", []);
      const MockV2Pair = await ethers.getContractFactory("MockV2Pair");

      // pair1 (flash source): 100 WETH / 50000 TST (1:500)
      flashPair = await MockV2Pair.deploy(WETH_ADDRESS, token.target, false);
      await flashPair.waitForDeployment();
      flashPairAddr = flashPair.target;
      await weth.connect(owner).deposit({ value: ethers.parseEther("100") });
      await weth.connect(owner).transfer(flashPairAddr, ethers.parseEther("100"));
      await token.mint(flashPairAddr, ethers.parseUnits("50000", 18));
      await flashPair.sync();

      // pair2 (trade): 50 WETH / 200000 TST (1:4000, TST much cheaper here)
      tradePair = await MockV2Pair.deploy(WETH_ADDRESS, token.target, false);
      await tradePair.waitForDeployment();
      tradePairAddr = tradePair.target;
      await weth.connect(owner).deposit({ value: ethers.parseEther("50") });
      await weth.connect(owner).transfer(tradePairAddr, ethers.parseEther("50"));
      await token.mint(tradePairAddr, ethers.parseUnits("200000", 18));
      await tradePair.sync();
    });

    after(async function () {
      await ethers.provider.send("evm_revert", [snapshot]);
    });

    it("V2 flash: borrow WETH → swap WETH→TST on pair2 → sweep TST to pair1 (repay)", async function () {
      const token0 = await flashPair.token0();
      const wethIsToken0 = token0.toLowerCase() === WETH_ADDRESS.toLowerCase();
      const borrowAmount = ethers.parseEther("1");

      // Inner command 1: V2 adaptive swap borrowed WETH→TST on pair2
      const token0_2 = await tradePair.token0();
      const wethIsToken0_2 = token0_2.toLowerCase() === WETH_ADDRESS.toLowerCase();
      const swapOpcode = wethIsToken0_2 ? "00" : "01";
      const cmd1 = swapOpcode + V2_SWAP_SELECTOR + packFeeBps(30) +
        packAddress(tradePairAddr) + packAddress(WETH_ADDRESS) + packAmount112(borrowAmount);

      // Inner command 2: sweep TST to flashPair (repay flash loan)
      const cmd2 = "0e" + packAddress(token.target) + packAddress(flashPairAddr);

      const innerHex = cmd1 + cmd2;
      const innerLenHex = (innerHex.length / 2).toString(16).padStart(6, "0");

      // Flash: borrow WETH from flashPair
      // zeroForOne=true borrows token0 → v2_flash_z (0x10)
      // zeroForOne=false borrows token1 → v2_flash_o (0x11)
      // We want to borrow WETH: if WETH is token0, use flash_z (0x10, amount0=borrow)
      const flashOpcode = wethIsToken0 ? "10" : "11";

      const payload = "0x" + flashOpcode +
        V2_SWAP_SELECTOR +
        packAmount112(borrowAmount) +
        packAddress(flashPairAddr) +
        innerLenHex +
        innerHex;

      const receipt = await sendAndLog(operator, {
        to: mev.target,
        data: payload,
        value: BigInt(payload.substring(2).length / 2),
      }, this.test.title);

      // Verify events
      const transfers = parseTransfers(receipt);
      expect(transfers.length).to.be.gte(3);

      // Flash borrow: flashPair sends WETH to MEV
      const flashXfer = transfers.find(t =>
        t.from.toLowerCase() === flashPairAddr.toLowerCase() &&
        t.to.toLowerCase() === mev.target.toLowerCase() &&
        t.token === WETH_ADDRESS.toLowerCase()
      );
      expect(flashXfer, "flashPair must send WETH to MEV").to.exist;
      expect(flashXfer.value).to.equal(borrowAmount);

      // Swap on pair2: MEV sends WETH to tradePair
      const swapInXfer = transfers.find(t =>
        t.from.toLowerCase() === mev.target.toLowerCase() &&
        t.to.toLowerCase() === tradePairAddr.toLowerCase() &&
        t.token === WETH_ADDRESS.toLowerCase()
      );
      expect(swapInXfer, "MEV must send WETH to tradePair").to.exist;

      // Swap on pair2: tradePair sends TST to MEV
      const swapOutXfer = transfers.find(t =>
        t.from.toLowerCase() === tradePairAddr.toLowerCase() &&
        t.to.toLowerCase() === mev.target.toLowerCase() &&
        t.token === token.target.toLowerCase()
      );
      expect(swapOutXfer, "tradePair must send TST to MEV").to.exist;

      // Repay: MEV sweeps TST to flashPair
      const repayXfer = transfers.find(t =>
        t.from.toLowerCase() === mev.target.toLowerCase() &&
        t.to.toLowerCase() === flashPairAddr.toLowerCase() &&
        t.token === token.target.toLowerCase()
      );
      expect(repayXfer, "MEV must sweep TST to flashPair").to.exist;
      expect(repayXfer.value).to.be.gt(0n);
    });
  });

  describe("Flash chain: V3 flash swap (2-hop)", function () {
    let v3Pool, v3PoolAddr;
    let v2Pair, v2PairAddr;
    let v3Token0, v3Token1;
    let snapshot;

    const UNI_V3_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
    const POOL_INIT_CODE_HASH = "0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54";

    before(async function () {
      snapshot = await ethers.provider.send("evm_snapshot", []);

      // Determine token ordering for V3
      if (BigInt(WETH_ADDRESS) < BigInt(token.target)) {
        v3Token0 = WETH_ADDRESS;
        v3Token1 = token.target;
      } else {
        v3Token0 = token.target;
        v3Token1 = WETH_ADDRESS;
      }

      // Deploy V3 pool at deterministic address
      const salt = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "address", "uint24"],
          [v3Token0, v3Token1, 3000]
        )
      );
      v3PoolAddr = ethers.getCreate2Address(UNI_V3_FACTORY, salt, POOL_INIT_CODE_HASH);

      const MockV3Pool = await ethers.getContractFactory("MockV3Pool");
      const tempPool = await MockV3Pool.deploy(v3Token0, v3Token1, 3000, false);
      await tempPool.waitForDeployment();
      const poolCode = await ethers.provider.getCode(tempPool.target);
      await ethers.provider.send("hardhat_setCode", [v3PoolAddr, poolCode]);
      v3Pool = await ethers.getContractAt("MockV3Pool", v3PoolAddr);

      // Fund V3 pool: 100 WETH / 200000 TST
      await weth.connect(owner).deposit({ value: ethers.parseEther("100") });
      await weth.connect(owner).transfer(v3PoolAddr, ethers.parseEther("100"));
      await token.mint(v3PoolAddr, ethers.parseUnits("200000", 18));

      // V2 pair for swap leg: 50 WETH / 100000 TST (different ratio)
      const MockV2Pair = await ethers.getContractFactory("MockV2Pair");
      v2Pair = await MockV2Pair.deploy(WETH_ADDRESS, token.target, false);
      await v2Pair.waitForDeployment();
      v2PairAddr = v2Pair.target;
      await weth.connect(owner).deposit({ value: ethers.parseEther("50") });
      await weth.connect(owner).transfer(v2PairAddr, ethers.parseEther("50"));
      await token.mint(v2PairAddr, ethers.parseUnits("100000", 18));
      await v2Pair.sync();
    });

    after(async function () {
      await ethers.provider.send("evm_revert", [snapshot]);
    });

    it("V3 flash swap zfo: borrow TST → swap TST→WETH on V2 → sweep WETH to V3 pool (repay)", async function () {
      // V3 flash swap zfo: pool sends token1 to us, expects token0 back
      // If WETH is token0: zfo borrows TST(token1), we must repay WETH(token0)
      // If TST is token0: zfo borrows WETH(token1), we must repay TST(token0)
      const wethIsToken0 = v3Token0.toLowerCase() === WETH_ADDRESS.toLowerCase();

      // We want to borrow the token we can swap profitably
      // Let's borrow TST and swap TST→WETH on V2, then repay V3 with WETH
      let flashOpcode, borrowAmount;
      let inputToken, outputToken; // for V3: input=repay token, output=borrowed token

      if (wethIsToken0) {
        // token0=WETH, token1=TST. zfo borrows TST, repay WETH. Use flash_swap_z (0x12)
        flashOpcode = "12";
        borrowAmount = ethers.parseUnits("1000", 18); // borrow 1000 TST
        inputToken = WETH_ADDRESS;
        outputToken = token.target;
      } else {
        // token0=TST, token1=WETH. ofz borrows TST(token0), repay WETH(token1). Use flash_swap_o (0x13)
        // Actually: zfo borrows token1=WETH, repay token0=TST
        // ofz borrows token0=TST, repay token1=WETH
        flashOpcode = "13"; // flash_swap_o
        borrowAmount = ethers.parseUnits("1000", 18);
        inputToken = WETH_ADDRESS;
        outputToken = token.target;
      }

      // Inner commands (executed in V3 callback):
      // 1. V2 adaptive swap: TST → WETH on V2 pair (balanceOf fallback, amount=0)
      const v2Token0 = await v2Pair.token0();
      const tstIsV2Token0 = v2Token0.toLowerCase() === token.target.toLowerCase();
      const v2SwapOpcode = tstIsV2Token0 ? "00" : "01"; // zfo if TST is token0
      const cmd1 = v2SwapOpcode + V2_SWAP_SELECTOR + packFeeBps(30) +
        packAddress(v2PairAddr) + packAddress(token.target) + packAmount112(0n); // balanceOf fallback

      // 2. Sweep WETH to V3 pool (repay)
      const cmd2 = "0e" + packAddress(WETH_ADDRESS) + packAddress(v3PoolAddr);

      const innerHex = cmd1 + cmd2;
      const innerLenHex = (innerHex.length / 2).toString(16).padStart(6, "0");

      const payload = "0x" + flashOpcode +
        V3_SWAP_SELECTOR +
        packAmount112(borrowAmount) +
        packAddress(v3PoolAddr) +
        innerLenHex +
        innerHex;

      const receipt = await sendAndLog(operator, {
        to: mev.target,
        data: payload,
        value: BigInt(payload.substring(2).length / 2),
      }, this.test.title);

      // Verify events
      const transfers = parseTransfers(receipt);
      expect(transfers.length).to.be.gte(3);

      // V3 pool sends TST to MEV (flash borrow)
      const flashXfer = transfers.find(t =>
        t.from.toLowerCase() === v3PoolAddr.toLowerCase() &&
        t.to.toLowerCase() === mev.target.toLowerCase() &&
        t.token === token.target.toLowerCase()
      );
      expect(flashXfer, "V3 pool must send TST to MEV").to.exist;

      // V2 swap: MEV sends TST to v2Pair, v2Pair sends WETH to MEV
      const v2InXfer = transfers.find(t =>
        t.from.toLowerCase() === mev.target.toLowerCase() &&
        t.to.toLowerCase() === v2PairAddr.toLowerCase() &&
        t.token === token.target.toLowerCase()
      );
      expect(v2InXfer, "MEV must send TST to V2 pair").to.exist;

      // MEV sweeps WETH to V3 pool (repay)
      const repayXfer = transfers.find(t =>
        t.from.toLowerCase() === mev.target.toLowerCase() &&
        t.to.toLowerCase() === v3PoolAddr.toLowerCase() &&
        t.token === WETH_ADDRESS.toLowerCase()
      );
      expect(repayXfer, "MEV must sweep WETH to V3 pool").to.exist;
    });
  });

  describe("Flash chain: V2 flash 3-hop (V2→V2→repay)", function () {
    let flashPair, pair2, pair3;
    let flashPairAddr, pair2Addr, pair3Addr;
    let token2;
    let snapshot;

    before(async function () {
      snapshot = await ethers.provider.send("evm_snapshot", []);

      const MockERC20 = await ethers.getContractFactory("MockERC20");
      token2 = await MockERC20.deploy("Token2", "TK2", 18);
      await token2.waitForDeployment();

      const MockV2Pair = await ethers.getContractFactory("MockV2Pair");

      // flashPair: WETH/TST — flash borrow WETH
      flashPair = await MockV2Pair.deploy(WETH_ADDRESS, token.target, false);
      await flashPair.waitForDeployment();
      flashPairAddr = flashPair.target;
      await weth.connect(owner).deposit({ value: ethers.parseEther("100") });
      await weth.connect(owner).transfer(flashPairAddr, ethers.parseEther("100"));
      await token.mint(flashPairAddr, ethers.parseUnits("50000", 18));
      await flashPair.sync();

      // pair2: TST/TK2 — swap TST→TK2
      pair2 = await MockV2Pair.deploy(token.target, token2.target, false);
      await pair2.waitForDeployment();
      pair2Addr = pair2.target;
      await token.mint(pair2Addr, ethers.parseUnits("100000", 18));
      await token2.mint(pair2Addr, ethers.parseUnits("100000", 18));
      await pair2.sync();

      // pair3: TK2/WETH — swap TK2→WETH (skewed: more TK2, less WETH = TK2 cheap)
      pair3 = await MockV2Pair.deploy(token2.target, WETH_ADDRESS, false);
      await pair3.waitForDeployment();
      pair3Addr = pair3.target;
      await token2.mint(pair3Addr, ethers.parseUnits("10000", 18));
      await weth.connect(owner).deposit({ value: ethers.parseEther("100") });
      await weth.connect(owner).transfer(pair3Addr, ethers.parseEther("100"));
      await pair3.sync();
    });

    after(async function () {
      await ethers.provider.send("evm_revert", [snapshot]);
    });

    it("V2 flash 3-hop: borrow WETH → swap WETH→TST → swap TST→TK2 → swap TK2→WETH → repay", async function () {
      const borrowAmount = ethers.parseEther("1");

      // Determine token order for each pair
      const fp_token0 = await flashPair.token0();
      const wethIsFpToken0 = fp_token0.toLowerCase() === WETH_ADDRESS.toLowerCase();

      const p2_token0 = await pair2.token0();
      const tstIsP2Token0 = p2_token0.toLowerCase() === token.target.toLowerCase();

      const p3_token0 = await pair3.token0();
      const tk2IsP3Token0 = p3_token0.toLowerCase() === token2.target.toLowerCase();

      // Inner command 1: swap WETH→TST on pair2... wait, we need WETH→TST.
      // Actually: flashPair has WETH/TST. We borrow WETH and need to return it with profit.
      // Route: WETH →(pair2? no, pair2 is TST/TK2)
      // Let me rethink: we need to convert WETH→TST, TST→TK2, TK2→WETH
      // But we don't have a WETH→TST swap pair separate from flashPair...
      // flashPair IS the WETH/TST pair. We can't swap on it during flash.
      // So the 3-hop is: borrow WETH from flashPair → need to get TST somehow

      // Actually, let's change approach:
      // flashPair: WETH/TST — flash borrow TST (not WETH)
      // hop1: TST→TK2 on pair2
      // hop2: TK2→WETH on pair3
      // repay: sweep WETH to flashPair

      // Flash borrow TST from flashPair
      // If WETH is token0, TST is token1 → flash_o (0x11) borrows token1
      // If TST is token0, WETH is token1 → flash_z (0x10) borrows token0
      const flashOpcode = wethIsFpToken0 ? "11" : "10";

      const tstBorrowAmount = ethers.parseUnits("500", 18);

      // Inner cmd 1: swap TST→TK2 on pair2 (adaptive, balanceOf fallback)
      const cmd1Opcode = tstIsP2Token0 ? "00" : "01";
      const cmd1 = cmd1Opcode + V2_SWAP_SELECTOR + packFeeBps(30) +
        packAddress(pair2Addr) + packAddress(token.target) + packAmount112(0n);

      // Inner cmd 2: swap TK2→WETH on pair3 (adaptive, balanceOf fallback)
      const cmd2Opcode = tk2IsP3Token0 ? "00" : "01";
      const cmd2 = cmd2Opcode + V2_SWAP_SELECTOR + packFeeBps(30) +
        packAddress(pair3Addr) + packAddress(token2.target) + packAmount112(0n);

      // Inner cmd 3: sweep WETH to flashPair (repay)
      const cmd3 = "0e" + packAddress(WETH_ADDRESS) + packAddress(flashPairAddr);

      const innerHex = cmd1 + cmd2 + cmd3;
      const innerLenHex = (innerHex.length / 2).toString(16).padStart(6, "0");

      const payload = "0x" + flashOpcode +
        V2_SWAP_SELECTOR +
        packAmount112(tstBorrowAmount) +
        packAddress(flashPairAddr) +
        innerLenHex +
        innerHex;

      const receipt = await sendAndLog(operator, {
        to: mev.target,
        data: payload,
        value: BigInt(payload.substring(2).length / 2),
      }, this.test.title);

      // Verify events: should have 6+ transfers (flash out + 2 swaps in/out + repay)
      const transfers = parseTransfers(receipt);
      expect(transfers.length).to.be.gte(5);

      // Flash borrow TST from flashPair
      const flashXfer = transfers.find(t =>
        t.from.toLowerCase() === flashPairAddr.toLowerCase() &&
        t.to.toLowerCase() === mev.target.toLowerCase() &&
        t.token === token.target.toLowerCase()
      );
      expect(flashXfer, "flashPair must send TST to MEV").to.exist;

      // Hop 1: TST→TK2 on pair2
      const hop1In = transfers.find(t =>
        t.from.toLowerCase() === mev.target.toLowerCase() &&
        t.to.toLowerCase() === pair2Addr.toLowerCase() &&
        t.token === token.target.toLowerCase()
      );
      expect(hop1In, "MEV must send TST to pair2").to.exist;

      // Hop 2: TK2→WETH on pair3
      const hop2In = transfers.find(t =>
        t.from.toLowerCase() === mev.target.toLowerCase() &&
        t.to.toLowerCase() === pair3Addr.toLowerCase() &&
        t.token === token2.target.toLowerCase()
      );
      expect(hop2In, "MEV must send TK2 to pair3").to.exist;

      // Repay: WETH swept to flashPair
      const repayXfer = transfers.find(t =>
        t.from.toLowerCase() === mev.target.toLowerCase() &&
        t.to.toLowerCase() === flashPairAddr.toLowerCase() &&
        t.token === WETH_ADDRESS.toLowerCase()
      );
      expect(repayXfer, "MEV must sweep WETH to flashPair").to.exist;
      expect(repayXfer.value).to.be.gt(0n);
    });
  });

  // ============================================================
  // Multi-command pipeline: V2 swap + sweep + balance_check
  // ============================================================
  it("pipeline: V2 swap + sweep output", async function () {
    // Deploy pair
    const MockV2Pair = await ethers.getContractFactory("MockV2Pair");
    const pair = await MockV2Pair.deploy(WETH_ADDRESS, token.target, false);
    await pair.waitForDeployment();

    const wethLiq = ethers.parseEther("10");
    const tokenLiq = ethers.parseUnits("10000", 18);
    await weth.connect(owner).deposit({ value: wethLiq });
    await weth.connect(owner).transfer(pair.target, wethLiq);
    await token.mint(pair.target, tokenLiq);
    await pair.sync();

    const token0 = await pair.token0();
    const token1 = await pair.token1();

    const amountIn = ethers.parseUnits("50", 18);
    if (token0.toLowerCase() === WETH_ADDRESS.toLowerCase()) {
      await weth.connect(owner).deposit({ value: amountIn });
      await weth.connect(owner).transfer(mev.target, amountIn);
    } else {
      await token.mint(mev.target, amountIn);
    }

    // Command 1: V2 swap zfo
    const cmd1 = "00" + V2_SWAP_SELECTOR + packFeeBps(30) +
      packAddress(pair.target) + packAddress(token0) + packAmount112(amountIn);

    // Command 2: sweep token1 to alice
    const cmd2 = "0e" + packAddress(token1) + packAddress(alice.address);

    const payload = "0x" + cmd1 + cmd2;
    const aliceBefore = token1.toLowerCase() === WETH_ADDRESS.toLowerCase()
      ? await weth.balanceOf(alice.address)
      : await token.balanceOf(alice.address);

    await sendAndLog(operator, {
      to: mev.target,
      data: payload,
      value: BigInt(payload.substring(2).length / 2),
    }, this.test.title);

    const aliceAfter = token1.toLowerCase() === WETH_ADDRESS.toLowerCase()
      ? await weth.balanceOf(alice.address)
      : await token.balanceOf(alice.address);

    expect(aliceAfter).to.be.gt(aliceBefore);

    // MEV contract should have 0 token1 after sweep
    const mevToken1 = token1.toLowerCase() === WETH_ADDRESS.toLowerCase()
      ? await weth.balanceOf(mev.target)
      : await token.balanceOf(mev.target);
    expect(mevToken1).to.equal(0n);
  });

  // Sandwich backrun: V2 swap (amount=0, resolve from balanceOf) + balance_check + sweep
  // Simulates the on-chain backrun where MEV.huff resolves actual token balance.
  it("sandwich backrun: resolve amount=0 + balance_check + sweep to vault", async function () {
    const MockV2Pair = await ethers.getContractFactory("MockV2Pair");
    // token→WETH pair (backrun sells token, gets WETH)
    const pair = await MockV2Pair.deploy(token.target, WETH_ADDRESS, false);
    await pair.waitForDeployment();

    // Add liquidity: 10000 TOKEN + 10 WETH
    const wethLiq = ethers.parseEther("10");
    const tokenLiq = ethers.parseUnits("10000", 18);
    await weth.connect(owner).deposit({ value: wethLiq });
    await weth.connect(owner).transfer(pair.target, wethLiq);
    await token.mint(pair.target, tokenLiq);
    await pair.sync();

    const token0 = await pair.token0();
    const token1 = await pair.token1();
    const zfo = token0.toLowerCase() === token.target.toLowerCase();

    // Simulate frontrun output: send tokens to MEV contract (as if from a prior swap)
    const tokenAmount = ethers.parseUnits("100", 18);
    await token.mint(mev.target, tokenAmount);

    // Command 1: V2 swap with amount=0 → MEV.huff resolves via balanceOf(tokenIn)
    const opcode = zfo ? "00" : "01";
    const tokenIn = zfo ? token0 : token1;
    const cmd1 = opcode + V2_SWAP_SELECTOR + packFeeBps(30) +
      packAddress(pair.target) + packAddress(tokenIn) + packAmount112(0n);

    // Command 2: balance_check — verify WETH balance >= minWeth
    // minWeth = 1 wei (any non-zero amount means swap succeeded)
    const minWeth = 1n;
    const cmd2 = "0d" + packAddress(mev.target) + packAddress(WETH_ADDRESS) + packAmount112(minWeth);

    // Command 3: sweep WETH to alice (vault)
    const cmd3 = "0e" + packAddress(WETH_ADDRESS) + packAddress(alice.address);

    const payload = "0x" + cmd1 + cmd2 + cmd3;

    const aliceWethBefore = await weth.balanceOf(alice.address);

    const receipt = await sendAndLog(operator, {
      to: mev.target,
      data: payload,
      value: BigInt(payload.substring(2).length / 2),
    }, this.test.title);

    const aliceWethAfter = await weth.balanceOf(alice.address);
    const profit = aliceWethAfter - aliceWethBefore;

    // Verify: alice (vault) received WETH profit
    expect(profit).to.be.gt(0n, "vault must receive WETH profit from backrun");

    // Verify: MEV contract has 0 WETH after sweep
    const mevWeth = await weth.balanceOf(mev.target);
    expect(mevWeth).to.equal(0n, "MEV contract must have 0 WETH after sweep");

    // Verify: MEV contract has 0 token after swap (all sold)
    const mevToken = await token.balanceOf(mev.target);
    expect(mevToken).to.equal(0n, "MEV contract must have 0 token after swap");

    // Verify events: Transfer from pair to MEV (WETH out) + Transfer from MEV to alice (sweep)
    const transfers = parseTransfers(receipt);
    const wethOutTransfer = transfers.find(t =>
      t.from.toLowerCase() === pair.target.toLowerCase() &&
      t.token.toLowerCase() === WETH_ADDRESS.toLowerCase()
    );
    expect(wethOutTransfer, "must have WETH Transfer from pair").to.exist;
    expect(wethOutTransfer.value).to.be.gt(0n);

    const sweepTransfer = transfers.find(t =>
      t.from.toLowerCase() === mev.target.toLowerCase() &&
      t.to.toLowerCase() === alice.address.toLowerCase() &&
      t.token.toLowerCase() === WETH_ADDRESS.toLowerCase()
    );
    expect(sweepTransfer, "must have sweep Transfer to vault").to.exist;
    expect(sweepTransfer.value).to.equal(profit);

    console.log(`    profit: ${ethers.formatEther(profit)} ETH`);
  });

  // balance_check must revert when actual balance < minAmount
  it("balance_check reverts when balance insufficient", async function () {
    // balance_check: check that MEV contract has >= 1 ETH WETH (it doesn't)
    const minWeth = ethers.parseEther("1");
    const cmd = "0d" + packAddress(mev.target) + packAddress(WETH_ADDRESS) + packAmount112(minWeth);
    const payload = "0x" + cmd;

    await expect(
      operator.sendTransaction(
        await withOperatorFee({
          to: mev.target,
          data: payload,
          value: BigInt(payload.substring(2).length / 2),
        })
      )
    ).to.be.reverted;
  });
});
});
