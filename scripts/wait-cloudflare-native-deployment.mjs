import { waitForCloudflareStageDeployment } from "./cloudflare-deployment-readiness.mjs";

await waitForCloudflareStageDeployment(
  process.env.CLOUDFLARE_API_TOKEN,
  process.env.CLOUDFLARE_ACCOUNT_ID,
  Number(process.env.COVE_STAGE_SECRET_ROTATION_EPOCH_MS),
);
console.log("100% Cloudflare staging secret deployment settled; no Worker HTTP request sent.");
