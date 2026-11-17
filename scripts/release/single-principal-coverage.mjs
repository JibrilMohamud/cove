const ACCOUNT = "d26430caa63ec55f6612e32f36aca5e9";
const USER_ID = /^[a-f0-9]{32}$/;

function members(payload) {
  const rows = payload?.result;
  const info = payload?.result_info;
  if (
    !Array.isArray(rows) ||
    !info ||
    info.page !== 1 ||
    (info.total_pages !== undefined && info.total_pages !== 1) ||
    info.count !== rows.length ||
    info.total_count !== rows.length ||
    rows.length !== 1 ||
    rows[0]?.status !== "accepted" ||
    !USER_ID.test(rows[0]?.user?.id || "")
  )
    throw Error("principal_membership_not_single_complete");
  return rows[0].user.id;
}

// This narrow proof is possible only for an account with exactly ONE member.
// Never treat the current user's /user/tokens inventory as every principal
// without independently matching /user to a complete, stable members list.
// Multi-member/pending/partial/unreadable inventories remain blocked.
export async function inspectSinglePrincipalCoverage(get, accountToken, userToken) {
  const readMembers = async () => {
    try {
      return members(await get("/accounts/" + ACCOUNT + "/members", accountToken));
    } catch (error) {
      if (["writer_audit_http_401", "writer_audit_http_403"].includes(error?.message))
        throw Error("account_members_read_unauthorized");
      if (error?.message === "principal_membership_not_single_complete") throw error;
      throw Error("account_members_read_unavailable");
    }
  };
  try {
    const member = await readMembers();
    let identity;
    try {
      identity = (await get("/user", userToken))?.result?.id;
    } catch (error) {
      if (["writer_audit_http_401", "writer_audit_http_403"].includes(error?.message))
        throw Error("user_identity_read_unauthorized");
      throw Error("user_identity_read_unavailable");
    }
    if (!USER_ID.test(identity || "") || identity !== member)
      throw Error("principal_identity_mismatch");
    if ((await readMembers()) !== member) throw Error("principal_membership_changed");
    return { verified: true, reason: "single_member_identity_matched" };
  } catch (error) {
    // Only locally generated allowlisted categories; no identities or bodies.
    return { verified: false, reason: error.message };
  }
}
