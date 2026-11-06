// npm run oracle:update [-- --price 2200]   One Coinbase ETH/USD spot -> MockPriceOracle (keeper wallet).
import { cliArgs } from './demo-round-common.mjs';
import { updateOracle, oracleState } from './lib/oracle.mjs';

const args = cliArgs({ price: { type: 'string' } });
const r = await updateOracle({ price: args.price ? Number(args.price) : undefined });
const s = await oracleState();
console.log(`oracle now $${s.usd} (age ${s.age}s), update ${r.skipped ? 'skipped' : 'confirmed'}`);
