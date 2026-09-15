import { verifyCapabilities } from '../src/platform/cnb/capabilities';

const result = await verifyCapabilities({
  repository: process.env.CNB_REPO_SLUG,
  token: process.env.CNB_TOKEN,
  authorizedRepository: process.env.CNB_VERIFY_READS_FOR,
  ...(process.env.CNB_VERIFY_ISSUE ? { issueNumber: Number(process.env.CNB_VERIFY_ISSUE) } : {}),
  ...(process.env.CNB_VERIFY_REF ? { gitRef: process.env.CNB_VERIFY_REF } : {}),
  knowledge: process.env.CNB_VERIFY_KNOWLEDGE === 'true',
});
console.log(JSON.stringify(result, null, 2));
if (!result.ok || result.data.reads.some((read) => read.state !== 'observed')) process.exitCode = 1;
