/* eslint-disable prettier/prettier -- Private, typed canonical authority RPC. Never expose SQL or a caller-chosen route. */
import {z} from "zod/v3";

export type CanonicalOwnerPort={fetch(request:Request):Promise<Response>};
const ownerId=z.string().regex(/^[a-zA-Z0-9_-]{8,160}$/);
const subject=z.string().regex(/^[a-zA-Z0-9_-]{3,160}$/);
const operation=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/);
const shortOperation=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,95}$/);
const territory=z.string().regex(/^[A-Z]{2}$/);
const currency=z.string().regex(/^[A-Z]{3}$/);
const product=z.string().regex(/^prd_[a-zA-Z0-9_-]{3,120}$/)
  .refine(id=>!id.startsWith("prd_gutenberg_"),"Commercial product required");
const source=z.string().regex(/^(?:[0-9]{1,10}|(?:pgca|pgau|pgeu)_[a-z0-9_]{1,90})$/);
const evidence=z.string().regex(/^gre_[a-z0-9_:-]{1,120}$/);
const version=z.string().min(3).max(160).regex(/^[a-zA-Z0-9_-]+$/);
const routes={
  "commerce.create-quote":{path:"/commercial/checkout/create-quote",schema:z.object({
    userId:ownerId,
    request:z.object({
      territory:z.string().regex(/^[A-Za-z]{2}$/).optional(),
      billingAddress:z.object({
        name:z.string().min(1).max(120),line1:z.string().min(1).max(180),
        line2:z.string().max(180).optional(),city:z.string().min(1).max(120),
        state:z.string().max(120).optional(),postalCode:z.string().min(1).max(30),
        country:z.string().regex(/^[A-Za-z]{2}$/)
      }).strict(),
      promoCode:z.string().max(80).optional(),
      giftCardCode:z.string().max(120).optional(),
      useStoreCredit:z.boolean().optional()
    }).strict()
  }).strict()},
  "commerce.settle-order":{path:"/commercial/order/settle",schema:z.object({orderId:ownerId}).strict()},
  "commerce.recover-settlements":{path:"/commercial/order/recover-settlements",schema:z.object({limit:z.number().int().min(1).max(25)}).strict()},
  "commerce.revoke-order":{path:"/commercial/order/revoke",schema:z.object({orderId:ownerId,operationId:operation}).strict()},
  "commerce.register-stripe-customer":{path:"/commercial/checkout/register-stripe-customer",schema:z.object({
    userId:ownerId,customerId:z.string().regex(/^cus_[a-zA-Z0-9_-]{4,150}$/)
  }).strict()},
  "commerce.prepare-checkout-draft":{path:"/commercial/checkout/prepare-draft",schema:z.object({
    userId:ownerId,orderId:ownerId,quoteId:ownerId
  }).strict()},
  "commerce.materialize-checkout-draft":{path:"/commercial/checkout/materialize-draft",schema:z.object({
    userId:ownerId,quoteId:ownerId,
    idempotencyKey:z.string().min(16).max(200),
    cartFingerprint:z.string().min(16).max(1024),
    captureMethod:z.enum(["manual","automatic","automatic_async"]),
    soundsStation:z.string().regex(/^[a-z0-9-]{1,80}$/).optional(),
    soundsRecording:z.string().regex(/^(?:cm_[0-9]{1,15}|ex_[0-9a-f-]{36})$/).optional()
  }).strict()},
  "commerce.attach-payment-intent":{path:"/commercial/checkout/attach-payment-intent",schema:z.object({
    orderId:ownerId,userId:ownerId,
    paymentIntentId:z.string().regex(/^pi_[a-zA-Z0-9_-]{4,150}$/),
    customerId:z.string().regex(/^cus_[a-zA-Z0-9_-]{4,150}$/)
  }).strict()},
  "commerce.update-payment-state":{path:"/commercial/payment/update-state",schema:z.object({
    orderId:ownerId,paymentIntentId:z.string().regex(/^pi_[a-zA-Z0-9_-]{4,150}$/),
    state:z.enum(["processing","authorized","payment_failed","canceled"]),
    failureCode:z.string().max(100).regex(/^[a-zA-Z0-9_]*$/).nullable()
  }).strict()},
  "commerce.cancel-unpaid":{path:"/commercial/checkout/cancel-unpaid",schema:z.object({
    orderId:ownerId,userId:ownerId,source:z.enum(["customer","reconciliation"])
  }).strict()},
  "commerce.record-reconciliation":{path:"/commercial/reconciliation/record",schema:z.object({
    runId:z.string().regex(/^recon_[0-9a-f-]{36}$/),
    startedAt:z.string().datetime(),finishedAt:z.string().datetime(),
    checked:z.number().int().min(0).max(500),
    mismatches:z.number().int().min(0).max(500),
    repaired:z.number().int().min(0).max(500),
    details:z.array(z.record(z.string(),z.string().max(200))).max(100)
  }).strict()},
  "commerce.admin-monetary":{path:"/commercial/admin/monetary",schema:z.object({
    action:z.enum(["promo","gift-card","store-credit"]),
    operationId:z.string().min(16).max(150).regex(/^[A-Za-z0-9_.:-]+$/),
    actor:z.object({userId:z.string().min(3).max(180),
      authProvider:z.string().max(120),authSubject:z.string().max(240),
      aal:z.enum(["aal1","aal2"])}).strict(),
    payload:z.record(z.string(),z.unknown())
  }).strict()},
  "commerce.sync-dispute":{path:"/commercial/dispute/sync-verified",schema:z.object({
    disputeId:z.string().regex(/^dp_[a-zA-Z0-9_-]{4,150}$/),
    eventType:z.enum(["charge.dispute.created","charge.dispute.updated","charge.dispute.closed","charge.dispute.funds_withdrawn","charge.dispute.funds_reinstated"])
  }).strict()},
  "commerce.claim-webhook":{path:"/commercial/webhook/claim",schema:z.object({
    eventId:z.string().regex(/^evt_[a-zA-Z0-9_-]{4,150}$/),
    eventType:z.string().regex(/^[a-z0-9_.]{3,120}$/),
    payloadSha256:z.string().regex(/^[a-f0-9]{64}$/),livemode:z.boolean()
  }).strict()},
  "commerce.finish-webhook":{path:"/commercial/webhook/finish",schema:z.object({
    eventId:z.string().regex(/^evt_[a-zA-Z0-9_-]{4,150}$/),
    payloadSha256:z.string().regex(/^[a-f0-9]{64}$/),
    token:z.string().uuid(),outcome:z.enum(["processed","failed"])
  }).strict()},
  "commerce.reserve-refund":{path:"/commercial/refund/reserve",schema:z.object({
    orderId:ownerId,reason:z.string().max(500),idempotencyKey:z.string().min(16).max(200),
    amountMinor:z.number().int().positive().max(1_000_000_000_000).optional()
  }).strict()},
  "commerce.post-refund-accounting":{path:"/commercial/refund/post-accounting",schema:z.object({
    orderId:ownerId,refundId:ownerId}).strict()},
  "commerce.record-refund-provider":{path:"/commercial/refund/record-provider",schema:z.object({
    orderId:ownerId,refundId:ownerId,
    providerRefundId:z.string().regex(/^re_[a-zA-Z0-9_-]{4,200}$/),
    paymentIntentId:z.string().regex(/^pi_[a-zA-Z0-9_-]{4,200}$/),
    amountMinor:z.number().int().positive().max(1_000_000_000_000),
    currency:z.string().regex(/^[A-Z]{3}$/),
    status:z.enum(["pending","requires_action","succeeded","failed","canceled"])
  }).strict()},
  "commerce.publish-order":{path:"/commercial/entitlement/publish-order-verified",schema:z.object({
    orderId:ownerId,userId:ownerId,territory,channel:z.literal("retail")}).strict()},
  "commerce.publish-entitlement":{path:"/commercial/entitlement/publish-verified",schema:z.object({
    entitlementId:ownerId,userId:ownerId,productId:product,territory,channel:z.literal("retail")}).strict()},
  "partner.process-feed":{path:"/publishing/partner/process-feed",schema:z.object({
    limit:z.number().int().min(1).max(25),operationId:shortOperation
  }).strict()},
  "catalog.normalize-gutenberg":{path:"/catalog/normalize-gutenberg",schema:z.object({
    sourceId:source,operationId:shortOperation
  }).strict()},
  "catalog.personal-import":{path:"/catalog/personal-import",schema:z.object({
    id:z.string().regex(/^upload_[0-9a-f-]{36}$/),
    userId:ownerId,title:z.string().max(240),author:z.string().max(240),
    language:z.string().regex(/^[a-zA-Z-]{2,20}$/),
    objectKey:z.string().max(500),createdAt:z.string().datetime(),
    operationId:shortOperation
  }).strict()},
  "publishing.audio-qc-jobs":{path:"/publishing/audio/qc-jobs",schema:z.object({
    action:z.enum(["lease","complete"]),
    payload:z.record(z.string(),z.unknown()),
    operationId:shortOperation
  }).strict()},
  "publishing.worker-jobs":{path:"/publishing/worker/jobs",schema:z.object({
    action:z.enum(["lease-validation","complete-validation","lease-rights-scan","complete-rights-scan"]),
    payload:z.record(z.string(),z.unknown()),operationId:shortOperation
  }).strict()},
  "publishing.audio-metadata":{path:"/publishing/audio/metadata",schema:z.object({
    action:z.enum(["profile","narrators","agreement-add","agreement-end"]),
    userId:subject,payload:z.record(z.string(),z.unknown()),operationId:shortOperation
  }).strict()},
  "publishing.review-onboarding":{path:"/publishing/onboarding/review",schema:z.object({
    reviewerUserId:subject,accountId:subject,recordId:subject,
    kind:z.enum(["identity","tax","payout"]),
    status:z.enum(["verified","failed","expired","manual_review","restricted"]),
    reasonCode:z.string().max(120),
    withholdingBps:z.number().int().min(0).max(10000).optional(),
    requirementsDue:z.array(z.string().max(240)).max(100).optional(),
    operationId:shortOperation
  }).strict()},
  "publishing.save-contract-version":{path:"/publishing/contract/save-version",schema:z.object({
    actorUserId:ownerId,operationId:shortOperation,
    contract:z.record(z.string(),z.unknown())
  }).strict()},
  "publication.materialize":{path:"/publication/materialize-submission",schema:z.object({
    submissionId:version,reviewerUserId:z.string().regex(/^(?:[a-zA-Z0-9_-]{3,160}|system:automated-review)$/),
    operationId:shortOperation,territory,currency}).strict()},
  "publication.activate":{path:"/publication/activate-version",schema:z.object({
    publicationVersionId:version,actorUserId:subject.nullable(),
    triggerType:z.enum(["schedule","rollback","staff"]),
    operationId:shortOperation,territory,currency}).strict()},
  "publication.open-preorder":{path:"/publication/open-preorder",schema:z.object({
    publicationVersionId:version,operationId:shortOperation,territory,currency}).strict()},
  "publication.recover":{path:"/publication/recover-recorded",schema:z.object({
    operationId:shortOperation}).strict()},
  "rights.suspend-grant":{path:"/commercial/suspend-grant",schema:z.object({
    action:z.literal("suspend-grant"),targetId:subject,operationId:operation}).strict()},
  "rights.suspend-contract":{path:"/commercial/suspend-contract",schema:z.object({
    action:z.literal("suspend-contract"),targetId:subject,operationId:operation}).strict()},
  "rights.quarantine-source":{path:"/quarantine",schema:z.object({
    action:z.literal("quarantine-source"),sourceId:source,operationId:operation,message:z.string().max(500)}).strict()},
  "rights.revoke-source-evidence":{path:"/evidence/revoke",schema:z.object({
    action:z.literal("revoke-source-evidence"),sourceId:source,evidenceId:evidence,
    territory,operationId:operation}).strict()},
  "rights.retract-sources":{path:"/source/retract-batch",schema:z.object({
    action:z.literal("retract-sources"),operations:z.array(z.object({
      sourceId:source,operationId:operation
    }).strict()).min(1).max(25).refine(rows=>new Set(rows.map(r=>r.sourceId)).size===rows.length)}).strict()},
  "rights.withdraw-retail":{path:"/commercial/retail/withdraw",schema:z.object({
    action:z.literal("withdraw-retail"),productId:product,operationId:operation}).strict()},
  "rights.publish-retail":{path:"/commercial/retail/publish-verified",schema:z.object({
    action:z.literal("publish-retail"),productId:product,territory,currency,operationId:operation}).strict()},
  "rights.pause-market":{path:"/market/withdraw",schema:z.object({
    action:z.literal("pause-market"),territory,operationId:operation}).strict()},
  "rights.revoke-entitlement":{path:"/commercial/entitlement/revoke",schema:z.object({
    action:z.literal("revoke-entitlement"),entitlementId:ownerId,operationId:operation}).strict()},
  "rights.withdraw-distribution":{path:"/commercial/distribution/withdraw",schema:z.object({
    action:z.literal("withdraw-distribution"),publicationVersionId:subject,
    status:z.enum(["blocked","recalled"]),allowExistingOwners:z.literal(false),
    reasonCode:z.string().min(1).max(120),reasonDetail:z.string().max(2000),
    actorUserId:subject,operationId:operation}).strict()}
} as const;
export type CanonicalCommandKind=keyof typeof routes;
const isQuarantine=(kind:CanonicalCommandKind)=>kind.startsWith("rights.");
const record=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==="object"&&!Array.isArray(x);
const positiveEpoch=(x:unknown)=>Number.isSafeInteger(x)&&Number(x)>0;

/** Fixed route catalog: callers cannot pick a URL, substitute an identity,
 * attach raw SQL, or select the wrong private writer plane. Receipt checks
 * below are deliberately duplicated by sensitive domain consumers; neither
 * layer may treat HTTP 200 alone as proof of a successful authorization. */
export async function dispatchCanonicalOwnerCommand(
  port:CanonicalOwnerPort,secret:string,kind:CanonicalCommandKind,raw:unknown
):Promise<Record<string,unknown>> {
  const definition=Object.prototype.hasOwnProperty.call(routes,kind)?
    routes[kind]:undefined;
  if(!definition||!/^[a-f0-9]{64}$/.test(secret)||!port||typeof port.fetch!=="function")
    throw Error("canonical_command_binding_invalid");
  const body=definition.schema.parse(raw) as Record<string,unknown>;
  const encoded=JSON.stringify(body);
  if(encoded.length>(["publishing.worker-jobs","publishing.audio-qc-jobs"].includes(kind)?262144:kind==="publishing.save-contract-version"?32768:8192))throw Error("canonical_command_too_large");
  const root=isQuarantine(kind)?"https://legal-quarantine.internal":"https://legal-authority.internal";
  const response=await port.fetch(new Request(root+definition.path,{
    method:"POST",headers:{
      "authorization":"Bearer "+secret,
      "content-type":"application/json",
      "cache-control":"no-store"
    },body:encoded
  }));
  if(response.status!==200)throw Error("canonical_command_owner_refused");
  const bytes=await response.text();
  if(bytes.length>(["publishing.worker-jobs","publishing.audio-qc-jobs"].includes(kind)?524288:131072))throw Error("canonical_command_receipt_too_large");
  let ack:unknown;
  try{ack=JSON.parse(bytes);}catch{throw Error("canonical_command_receipt_invalid");}
  if(!record(ack))throw Error("canonical_command_receipt_invalid");
  switch(kind){
    case "commerce.create-quote": {
      const numeric=["subtotalMinor","taxMinor","taxInclusiveMinor",
        "giftCardMinor","storeCreditMinor","totalMinor","stripeDueMinor"];
      if(ack.schema!=="cove.owner-checkout-quote.v1"||ack.userId!==body.userId||
         ack.persisted!==true||!/^quote_[0-9a-f-]{36}$/.test(String(ack.id))||
         !currency.safeParse(ack.currency).success||
         !Array.isArray(ack.items)||ack.items.length<1||ack.items.length>25||
         numeric.some(x=>!Number.isSafeInteger(ack[x])||Number(ack[x])<0)||
         Number(ack.giftCardMinor)+Number(ack.storeCreditMinor)+
           Number(ack.stripeDueMinor)!==Number(ack.totalMinor)||
         Number(ack.subtotalMinor)-Number(record(ack.promo)?ack.promo.amountMinor||0:0)+
           Number(ack.taxMinor)!==Number(ack.totalMinor))
        throw Error("canonical_command_receipt_mismatch");
      break;
    }
    case "commerce.recover-settlements":
      if(ack.schema!=="cove.owner-settlement-recovery.v1"||
         ![ack.checked,ack.recovered,ack.blocked].every(n=>Number.isSafeInteger(n)&&Number(n)>=0&&Number(n)<=Number(body.limit))||
         Number(ack.checked)!==Number(ack.recovered)+Number(ack.blocked))
        throw Error("canonical_command_receipt_mismatch");
      break;
    case "commerce.settle-order":
      if(ack.schema!=="cove.owner-paid-settlement.v1"||ack.orderId!==body.orderId||
         ack.settled!==true||ack.effectsReconciled!==true||ack.accessPublished!==true||
         typeof ack.applied!=="boolean")throw Error("canonical_command_receipt_mismatch");
      break;
    case "commerce.revoke-order":
      if(ack.schema!=="cove.paid-order-revocation.v1"||ack.orderDenied!==true||
         ack.reconciled!==true||ack.orderId!==body.orderId||ack.operationId!==body.operationId)
        throw Error("canonical_command_receipt_mismatch");
      break;
    case "commerce.register-stripe-customer":
      if(ack.schema!=="cove.owner-stripe-customer.v1"||ack.userId!==body.userId||
         ack.customerId!==body.customerId||ack.bound!==true||
         typeof ack.applied!=="boolean")
        throw Error("canonical_command_receipt_mismatch");
      break;
    case "commerce.prepare-checkout-draft":
      if(ack.schema!=="cove.owner-checkout-preparation.v1"||
         ack.userId!==body.userId||ack.orderId!==body.orderId||
         ack.quoteId!==body.quoteId||
         (ack.ready!==true&&ack.ready!==false)||
         (ack.ready===true&&(
           ack.blocked!==false||ack.riskAction===undefined||
           !["allow","monitor","challenge","hold"].includes(String(ack.riskAction))||
           !["manual","automatic","automatic_async"].includes(String(ack.captureMethod))||
           ack.tenderReserved!==true||ack.quoteConsumed!==true))||
         (ack.ready===false&&(ack.blocked!==true||ack.tenderReserved!==false||
           ack.quoteConsumed!==false)))
        throw Error("canonical_command_receipt_mismatch");
      break;
    case "commerce.materialize-checkout-draft":
      if(ack.schema!=="cove.owner-checkout-draft.v1"||
         ack.userId!==body.userId||ack.quoteId!==body.quoteId||
         ack.idempotencyKey!==body.idempotencyKey||
         typeof ack.orderId!=="string"||!/^ord_[a-f0-9-]{36}$/.test(ack.orderId)||
         ack.currency===undefined||!currency.safeParse(ack.currency).success||
         !Number.isSafeInteger(ack.stripeDueMinor)||Number(ack.stripeDueMinor)<0||
         !Number.isSafeInteger(ack.lineCount)||Number(ack.lineCount)<1||
         Number(ack.lineCount)>25||typeof ack.created!=="boolean"||
         ack.riskAssessed!==false||ack.tenderReserved!==false||
         ack.quoteConsumed!==false||ack.paymentAuthorized!==false)
        throw Error("canonical_command_receipt_mismatch");
      break;
    case "commerce.attach-payment-intent":
      if(ack.schema!=="cove.owner-checkout-payment-binding.v1"||
         ack.orderId!==body.orderId||ack.userId!==body.userId||
         ack.paymentIntentId!==body.paymentIntentId||ack.customerId!==body.customerId||
         ack.bound!==true||typeof ack.applied!=="boolean"||
         !Number.isSafeInteger(ack.stripeDueMinor)||Number(ack.stripeDueMinor)<=0)
        throw Error("canonical_command_receipt_mismatch");
      break;
    case "commerce.update-payment-state":
      if(ack.schema!=="cove.owner-payment-state.v1"||ack.orderId!==body.orderId||
         ack.paymentIntentId!==body.paymentIntentId||ack.state!==body.state||
         typeof ack.applied!=="boolean"||ack.ownerRecorded!==true)
        throw Error("canonical_command_receipt_mismatch");
      break;
    case "commerce.cancel-unpaid":
      if(ack.schema!=="cove.owner-unpaid-cancellation.v1"||
         ack.orderId!==body.orderId||ack.userId!==body.userId||
         ack.canceled!==true||ack.tenderReleased!==true||
         typeof ack.providerVerified!=="boolean")
        throw Error("canonical_command_receipt_mismatch");
      break;
    case "commerce.record-reconciliation":
      if(ack.schema!=="cove.owner-reconciliation-report.v1"||
         ack.runId!==body.runId||ack.recorded!==true||
         ack.checked!==body.checked||ack.mismatches!==body.mismatches||
         ack.repaired!==body.repaired)
        throw Error("canonical_command_receipt_mismatch");
      break;
    case "commerce.admin-monetary":
      if(ack.schema!=="cove.owner-monetary-admin.v1"||
         ack.action!==body.action||ack.operationId!==body.operationId||
         ack.applied!==true||
         (body.action==="promo"&&(typeof ack.codeLabel!=="string"||typeof ack.active!=="boolean"))||
         (body.action==="gift-card"&&(!/^FORE-[0-9A-F]{16}$/.test(String(ack.code))||
             !currency.safeParse(ack.currency).success||
             !Number.isSafeInteger(ack.amountMinor)))||
         (body.action==="store-credit"&&(ack.userId!==(body.payload as Record<string,unknown>).userId||
             !currency.safeParse(ack.currency).success||
             !Number.isSafeInteger(ack.balanceMinor)||Number(ack.balanceMinor)<0)))
        throw Error("canonical_command_receipt_mismatch");
      break;
    case "commerce.sync-dispute":
      if(ack.schema!=="cove.owner-dispute-sync.v1"||
         ack.disputeId!==body.disputeId||ack.synced!==true||
         typeof ack.linked!=="boolean"||typeof ack.ownerDenied!=="boolean"||
         (ack.linked&&ack.ownerDenied!==true)||
         typeof ack.accountingReconciled!=="boolean"||
         ack.accountingReconciled!==true)
        throw Error("canonical_command_receipt_mismatch");
      break;
    case "commerce.claim-webhook":
      if(ack.schema!=="cove.owner-webhook-claim.v1"||ack.eventId!==body.eventId||
         ack.payloadSha256!==body.payloadSha256||typeof ack.duplicate!=="boolean"||
         typeof ack.claimed!=="boolean"||ack.duplicate===ack.claimed||
         (ack.claimed&&!z.string().uuid().safeParse(ack.token).success)||
         (ack.duplicate&&ack.token!==null))
        throw Error("canonical_command_receipt_mismatch");
      break;
    case "commerce.finish-webhook":
      if(ack.schema!=="cove.owner-webhook-finish.v1"||
         ack.eventId!==body.eventId||ack.payloadSha256!==body.payloadSha256||
         ack.outcome!==body.outcome||ack.token!==body.token||ack.finished!==true)
        throw Error("canonical_command_receipt_mismatch");
      break;
    case "commerce.reserve-refund":
      if(ack.schema!=="cove.owner-refund-reservation.v1"||
         ack.orderId!==body.orderId||!ownerId.safeParse(ack.refundId).success||
         typeof ack.created!=="boolean"||
         ![ack.amountMinor,ack.stripeAmountMinor,ack.giftCardAmountMinor,ack.storeCreditAmountMinor]
          .every(n=>Number.isSafeInteger(n)&&Number(n)>=0&&Number(n)<=1_000_000_000_000)||
         Number(ack.amountMinor)===0||
         Number(ack.stripeAmountMinor)+Number(ack.giftCardAmountMinor)+
         Number(ack.storeCreditAmountMinor)!==Number(ack.amountMinor)||
         (body.amountMinor!==undefined&&ack.amountMinor!==body.amountMinor))
        throw Error("canonical_command_receipt_mismatch");
      break;
    case "commerce.record-refund-provider":
      if(ack.schema!=="cove.owner-refund-provider.v1"||
         ack.ownerDenied!==true||ack.providerRecorded!==true||
         ack.orderId!==body.orderId||ack.refundId!==body.refundId||
         ack.providerRefundId!==body.providerRefundId||
         (typeof ack.status!=="string"||
          !["pending","requires_action","succeeded","failed","canceled"].includes(ack.status)))
        throw Error("canonical_command_receipt_mismatch");
      break;
    case "commerce.post-refund-accounting":
      if(ack.schema!=="cove.owner-refund-accounting.v1"||ack.ownerDenied!==true||
        ack.posted!==true||ack.royaltiesReconciled!==true||ack.orderId!==body.orderId||ack.refundId!==body.refundId||
        typeof ack.applied!=="boolean")
        throw Error("canonical_command_receipt_mismatch");
      break;
    case "commerce.publish-order":
      if(ack.applied!==true||ack.orderId!==body.orderId||
         !Array.isArray(ack.receipts)||!ack.receipts.length||ack.receipts.length>25||
         ack.receipts.some(x=>!record(x)||typeof x.entitlementId!=="string"||!positiveEpoch(x.epoch)))
        throw Error("canonical_command_receipt_mismatch");
      break;
    case "commerce.publish-entitlement":
      if(ack.applied!==true||!positiveEpoch(ack.epoch))
        throw Error("canonical_command_receipt_mismatch");
      break;
    case "partner.process-feed":
      if(ack.schema!=="cove.owner-partner-feed-sandbox.v1"||ack.ownerFirst!==true||
         ack.operationId!==body.operationId||
         ![ack.leased,ack.applied,ack.failed,ack.sandbox].every(n=>
           Number.isSafeInteger(n)&&Number(n)>=0&&Number(n)<=Number(body.limit))||
         Number(ack.applied)+Number(ack.failed)!==Number(ack.leased)||
         Number(ack.sandbox)!==Number(ack.leased))
        throw Error("canonical_command_receipt_mismatch");
      break;
    case "catalog.normalize-gutenberg":
      if(ack.schema!=="cove.owner-catalog-free.v1"||ack.ownerFirst!==true||
         ack.operationId!==body.operationId||ack.sourceId!==body.sourceId||
         ack.productId!=="prd_gutenberg_"+body.sourceId||ack.applied!==true)
        throw Error("canonical_command_receipt_mismatch");
      break;
    case "catalog.personal-import":
      if(ack.schema!=="cove.owner-personal-import.v1"||ack.ownerFirst!==true||
         ack.operationId!==body.operationId||ack.userId!==body.userId||
         ack.importId!==body.id||ack.productId!=="prd_"+body.id||
         typeof ack.applied!=="boolean")
        throw Error("canonical_command_receipt_mismatch");
      break;
    case "publishing.audio-qc-jobs":
      if(ack.schema!=="cove.owner-audio-qc-jobs.v1"||ack.ownerFirst!==true||
         ack.action!==body.action||ack.operationId!==body.operationId||
         !record(ack.result)||
         (body.action==="lease"&&!Array.isArray(ack.result.jobs))||
         (body.action==="complete"&&
          (typeof ack.result.id!=="string"||!["passed","failed","warning"].includes(String(ack.result.status)))))
        throw Error("canonical_command_receipt_mismatch");
      break;
    case "publishing.worker-jobs":
      if(ack.schema!=="cove.owner-publishing-worker-jobs.v1"||
         ack.ownerFirst!==true||ack.operationId!==body.operationId||
         ack.action!==body.action||!record(ack.result)||
         (String(body.action).startsWith("lease-")&&!Array.isArray(ack.result.jobs))||
         (body.action==="complete-rights-scan"&&
           (typeof ack.result.id!=="string"||!["passed","failed","blocked"].includes(String(ack.result.status))))||
         (body.action==="complete-validation"&&typeof ack.result.assetVersionId!=="string"))
        throw Error("canonical_command_receipt_mismatch");
      break;
    case "publishing.audio-metadata":
      if(ack.schema!=="cove.owner-audio-metadata.v1"||ack.ownerFirst!==true||
         ack.operationId!==body.operationId||ack.action!==body.action||
         ack.userId!==body.userId||!record(ack.result)||
         (["profile","narrators"].includes(String(ack.action))&&ack.result.saved!==true)||
         (["agreement-add","agreement-end"].includes(String(ack.action))&&
          (typeof ack.result.id!=="string"||ack.result.id.length<3)))
        throw Error("canonical_command_receipt_mismatch");
      break;
    case "publishing.review-onboarding":
      if(ack.schema!=="cove.owner-publishing-onboarding-negative.v1"||ack.ownerFirst!==true||
         ack.operationId!==body.operationId||ack.accountId!==body.accountId||
         ack.recordId!==body.recordId||ack.kind!==body.kind||ack.status!==body.status||
         typeof ack.applied!=="boolean"||ack.saved!==true)
        throw Error("canonical_command_receipt_mismatch");
      break;
    case "publishing.save-contract-version":
      if(ack.schema!=="cove.owner-contract-version.v1"||ack.ownerFirst!==true||
         ack.operationId!==body.operationId||
         ack.contractId!==(body.contract as Record<string,unknown>).contractId||
         ack.versionNumber!==(body.contract as Record<string,unknown>).versionNumber||
         ack.status!==((body.contract as Record<string,unknown>).status||"draft")||
         !version.safeParse(ack.id).success||
         ack.ownerDenied!==(ack.status!=="draft")||ack.stored!==true)
        throw Error("canonical_command_receipt_mismatch");
      break;
    case "publication.materialize":
      if(ack.schema!=="cove.publication-materialization.v1"||ack.ownerFirst!==true||
         ack.operationId!==body.operationId||ack.submissionId!==body.submissionId||
         typeof ack.productId!=="string"||!product.safeParse(ack.productId).success||
         !version.safeParse(ack.publicationId).success||!version.safeParse(ack.publicationVersionId).success||
         !version.safeParse(ack.editionId).success||!version.safeParse(ack.workId).success||
         !["auto_update","manual_opt_in","preserve_purchased_version"].includes(String(ack.ownerUpdatePolicy))||
         !["live","updated","preorder","scheduled"].includes(String(ack.releaseState))||
         typeof ack.accessPublished!=="boolean"||ack.releaseState!=="scheduled"&&ack.accessPublished!==true||
         !positiveEpoch(ack.versionNumber))
        throw Error("canonical_command_receipt_mismatch");
      break;
    case "publication.activate":
      if(ack.schema!=="cove.publication-activation.v1"||ack.ownerFirst!==true||
         ack.operationId!==body.operationId||ack.publicationVersionId!==body.publicationVersionId||
         !["live","updated"].includes(String(ack.state))||!positiveEpoch(ack.versionNumber))
        throw Error("canonical_command_receipt_mismatch");
      break;
    case "publication.open-preorder":
      if(ack.schema!=="cove.publication-preorder.v1"||ack.ownerFirst!==true||
         ack.operationId!==body.operationId||ack.publicationVersionId!==body.publicationVersionId||
         ack.state!=="preorder"||!positiveEpoch(ack.versionNumber))
        throw Error("canonical_command_receipt_mismatch");
      break;
    case "publication.recover":
      if(ack.schema!=="cove.publication-recovery.v1"||ack.ownerFirst!==true||
         ack.operationId!==body.operationId||
         ![ack.checked,ack.recovered,ack.blocked].every(n=>Number.isSafeInteger(n)&&Number(n)>=0&&Number(n)<=25)||
         Number(ack.checked)!==Number(ack.recovered)+Number(ack.blocked))
        throw Error("canonical_command_receipt_mismatch");
      break;
    case "rights.suspend-grant":
    case "rights.suspend-contract":
      if(ack.suspended!==true||ack.ownerDenied!==true||
         ack.subject!==(kind==="rights.suspend-grant"?"grant":"contract")||
         ack.subjectId!==body.targetId)throw Error("canonical_command_receipt_mismatch");
      break;
    case "rights.quarantine-source":
      if(ack.quarantined!==true||ack.sourceId!==body.sourceId)
        throw Error("canonical_command_receipt_mismatch");
      break;
    case "rights.revoke-source-evidence":
      if(ack.evidenceRevoked!==true||ack.sourceId!==body.sourceId||
         ack.evidenceId!==body.evidenceId||ack.territory!==body.territory)
        throw Error("canonical_command_receipt_mismatch");
      break;
    case "rights.retract-sources":
      if(ack.retracted!==(body.operations as unknown[]).length||
         !Array.isArray(ack.sourceIds)||
         ack.sourceIds.length!==(body.operations as unknown[]).length||
         ack.sourceIds.some((id,i)=>id!==(body.operations as {sourceId:string}[])[i]?.sourceId))
        throw Error("canonical_command_receipt_mismatch");
      break;
    case "rights.withdraw-retail":
      if(ack.withdrawn!==true||!positiveEpoch(ack.ownerEpoch))
        throw Error("canonical_command_receipt_mismatch");
      break;
    case "rights.publish-retail":
      if(ack.published!==true||!positiveEpoch(ack.ownerEpoch))
        throw Error("canonical_command_receipt_mismatch");
      break;
    case "rights.pause-market":
      if(ack.marketWithdrawn!==true||ack.territory!==body.territory)
        throw Error("canonical_command_receipt_mismatch");
      break;
    case "rights.revoke-entitlement":
      if(ack.revoked!==true||!positiveEpoch(ack.epoch))
        throw Error("canonical_command_receipt_mismatch");
      break;
    case "rights.withdraw-distribution":
      if(ack.withdrawn!==true||ack.ownerDenied!==true||
         ack.publicationVersionId!==body.publicationVersionId||
         ack.status!==body.status||!positiveEpoch(ack.ownerEpoch))
        throw Error("canonical_command_receipt_mismatch");
      break;
    default: {
      const impossible:never=kind;
      throw Error("unknown_canonical_command_"+String(impossible));
    }
  }
  return ack;
}
