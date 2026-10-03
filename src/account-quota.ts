import type { AccountQuota, HarnessCatalog } from "./contracts.ts";

/** Every catalog row states its actual account quota source. No inferred allowance. */
export const accountQuotaCoverage: Record<HarnessCatalog["harness"], { source: string | null; unavailableMessage: string }> = {
  codex: { source: "account/rateLimits/read", unavailableMessage: "Codex account limits could not be read through its native app server. Check native sign-in and refresh Models." },
  claude: { source: "native SDK experimental usage read", unavailableMessage: "Claude plan limits could not be read through its experimental native usage API. API-key, Bedrock and Vertex profiles do not report Claude subscription limits here. Check /usage in Claude Code." },
  muse: { source: "usage/read (last-seen observation)", unavailableMessage: "Muse usage/read has no valid last-seen subscription observation. It does not fetch a live balance; account allowance remains unknown." },
  antigravity: { source: "agy -p /usage (grouped limits)", unavailableMessage: "Antigravity grouped account limits could not be read through native agy /usage. Account access and billing remain unknown." },
  opencode: { source: null, unavailableMessage: "OpenCode does not expose remaining provider account allowance through this native adapter. Its stats command reports local session tokens and cost. Check the selected provider's account dashboard." },
  "cursor-agent": { source: null, unavailableMessage: "Cursor account quota is unavailable through this native adapter. Check the Usage view in Cursor account settings; CLI activity and session usage do not establish remaining plan allowance." },
  zcode: { source: null, unavailableMessage: "ZCode account quota is unavailable through this native adapter. Its usage/stats protocol reports local session activity. Check the coding plan in the native app or provider account dashboard." },
};

export function unavailableAccountQuota(harness: HarnessCatalog["harness"], installed = true): AccountQuota {
  return { status: "unavailable", ordinaryUsageAllowed: null, buckets: [],
    message: installed ? accountQuotaCoverage[harness].unavailableMessage
      : `${harness} executable was not found on this host. Account quota could not be checked. Desktop app sign-in does not establish CLI account access.` };
}
