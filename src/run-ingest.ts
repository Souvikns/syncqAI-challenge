import { ingest, loadConfig } from './ingest';

const config = loadConfig();
const db = await ingest(config);

const countOf = (table: string) => (db.query(`SELECT COUNT(*) as n FROM ${table}`).get() as { n: number }).n;

console.log(`Ingested into ${config.stateDir}/context.db`);
console.log(`  vehicles:           ${countOf('vehicles')}`);
console.log(`  drivers:            ${countOf('drivers')}`);
console.log(`  maintenance_events: ${countOf('maintenance_events')}`);
console.log(`  trip_history:       ${countOf('trip_history')}`);
console.log(`  conflicts:          ${countOf('conflicts')}`);
console.log(`  quarantine:         ${countOf('quarantine')}`);
console.log(`  text_units:         ${countOf('text_units')}`);

db.close();
