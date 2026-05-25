#!/usr/bin/env node
// Compute OP_HASH constants for MEV_V2.huff / MEV_V2.yul (operator slots 0..9)
// and Vault.sol initialiser hashes (operator slots 0..10, slot 10 = Vault address).
//
// Usage:
//   node scripts/compute_op_hashes.js 0xOp0 0xOp1 ... 0xVault
//
// Pass exactly 11 addresses: 10 EOA operators + 1 Vault contract address.
// Output:
//   * 11 `#define constant OP_HASH_i = 0x...` lines (paste into MEV_V2.huff)
//   * 11 `case i { expected := 0x... }` lines (paste into MEV_V2.yul)
//   * 11 `OP_HASH_i = keccak256(abi.encodePacked(addr, uint256(i)));` lines (paste into Vault.sol constructor)

const { keccak256, AbiCoder, getAddress, solidityPacked } = require("ethers");

const args = process.argv.slice(2);
if (args.length !== 11) {
  console.error("usage: node scripts/compute_op_hashes.js <op0> <op1> ... <op9> <vault>");
  console.error("       (exactly 11 addresses required)");
  process.exit(1);
}

const addrs = args.map((a, i) => {
  try {
    return getAddress(a);
  } catch (e) {
    console.error(`arg ${i} is not a valid address: ${a}`);
    process.exit(1);
  }
});

const ac = AbiCoder.defaultAbiCoder();

console.log("// --- MEV_V2.huff (paste into Constants block) ---");
for (let i = 0; i < 11; i++) {
  const hash = keccak256(ac.encode(["address"], [addrs[i]]));
  console.log(`#define constant OP_HASH_${i.toString().padEnd(2)} = ${hash}`);
}

console.log("\n// --- MEV_V2.yul (paste into check_operator switch) ---");
for (let i = 0; i < 11; i++) {
  const hash = keccak256(ac.encode(["address"], [addrs[i]]));
  console.log(`case ${i.toString().padStart(2)} { expected := ${hash} }`);
}

console.log("\n// --- Vault.sol (paste into constructor) ---");
for (let i = 0; i < 11; i++) {
  const hash = keccak256(solidityPacked(["address", "uint256"], [addrs[i], i]));
  console.log(`OP_HASH_${i} = keccak256(abi.encodePacked(address(${addrs[i]}), uint256(${i})));    // -> ${hash}`);
}
