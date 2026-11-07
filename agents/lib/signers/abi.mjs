// Helpers to describe a contract call the way Circle's Wallets API wants it.
import { getAbiItem } from 'viem';

const typeOf = (p) => (p.type.startsWith('tuple') ? `(${p.components.map(typeOf).join(',')})${p.type.slice(5)}` : p.type);

export function abiFunction(abi, functionName, args = []) {
  const item = getAbiItem({ abi, name: functionName, args });
  if (!item || item.type !== 'function') throw new Error(`function ${functionName} not found in ABI`);
  return item;
}

/** "propose(uint256,(uint16),string)" */
export function functionSignature(item) {
  return `${item.name}(${item.inputs.map(typeOf).join(',')})`;
}

/** Circle accepts strings, integers, booleans and (nested) arrays: bigint becomes a decimal string, tuples become arrays. */
export function toCircleParams(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(toCircleParams);
  if (value && typeof value === 'object') return Object.values(value).map(toCircleParams);
  return value;
}

export const toWei = (decimalString) => {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(decimalString ?? '').trim());
  if (!m) return null;
  return BigInt(m[1] + (m[2] ?? '').padEnd(18, '0').slice(0, 18));
};
