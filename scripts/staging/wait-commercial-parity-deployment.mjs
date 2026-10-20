import { waitForCloudflareStageDeployment } from "../cloudflare-deployment-readiness.mjs";

await waitForCloudflareStageDeployment(
  process.env.CLOUDFLARE_API_TOKEN,
  process.env.CLOUDFLARE_ACCOUNT_ID,
  Number(process.env.COVE_STAGE_SECRET_ROTATION_EPOCH_MS),
  { workerName: "cove-commercial-parity-ssr-staging-20261020" },
);
console.log("Isolated stage secret deployment settled without Worker HTTP warming.");
