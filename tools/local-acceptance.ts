import { runLocalJourney } from '../tests/integration/local-journey';

const target = new URL(process.argv[2] ?? 'http://127.0.0.1:4312');
if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || !target.port || target.username || target.password || target.pathname !== '/' || target.search || target.hash)
  throw Error('Only an explicit loopback Web origin is allowed');
const result = await runLocalJourney((request) => fetch(request), target.origin);
console.log(JSON.stringify(result, null, 2));
