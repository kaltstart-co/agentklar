import { useEffect, useState } from "react";
import {
  Alert,
  Badge,
  Divider,
  Group,
  Loader,
  Paper,
  Progress,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { api } from "./api";

type Window = {
  used_percent: number | null;
  remaining_percent: number | null;
  window_duration_minutes: number | null;
  resets_at: number | null;
};
type UsageReading = {
  source: string;
  observed_at: string;
  account_pool_key: string | null;
  cached: boolean;
  spend_status: string;
  quota: {
    status: string;
    ordinary_usage_allowed: boolean | null;
    buckets: {
      id: string;
      name: string;
      primary: Window | null;
      secondary: Window | null;
    }[];
  };
  account_tokens: {
    status: string;
    lifetime_tokens: number | null;
    daily: { start_date: string; tokens: number }[];
  };
  registered_threads: {
    thread_key: string;
    run_ids: string[];
    status: string;
    total_tokens: number | null;
    source: string;
  }[];
  thread_estimate: {
    status: string;
    estimated_usd: number | null;
    source: string;
  } | null;
  warnings: string[];
};

export default function Usage({
  base,
  refresh,
}: {
  base: string;
  refresh: number;
}) {
  const [reading, setReading] = useState<UsageReading | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setReading(null);
    api<UsageReading>(`${base}/usage`, "GET", undefined, controller.signal)
      .then(setReading)
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [base, refresh]);
  if (loading)
    return (
      <Paper withBorder p="xl" radius="lg">
        <Group>
          <Loader size="sm" />
          <Text size="sm" c="dimmed">
            Reading the native account…
          </Text>
        </Group>
      </Paper>
    );
  if (!reading)
    return (
      <Paper withBorder p="xl" radius="lg">
        <Badge color="gray" mb="md">
          Unknown usage
        </Badge>
        <Title order={3}>Account readings are unavailable.</Title>
        <Text size="sm" c="dimmed" mt="sm">
          {error ||
            "Open the connected local supervisor with agentklar serve --open."}
        </Text>
        <Text size="sm" c="dimmed" mt="md">
          No cost, quota, or token total is inferred from tasks.
        </Text>
      </Paper>
    );
  const warnings = (reading.warnings || []).filter(
    (warning) =>
      warning !==
      "Account limits and token activity are shared with native tool use; they are not project consumption or an invoice",
  );
  return (
    <Stack>
      <Paper withBorder p="xl" radius="lg">
        <Group justify="space-between">
          <Title order={3}>Native account limits</Title>
          <Badge
            variant="light"
            color={reading.quota.status === "actual" ? "teal" : "gray"}
          >
            {reading.quota.status}
          </Badge>
        </Group>
        <Text size="sm" c="dimmed" mt="sm">
          These limits belong to the shared account. Work in other tools and
          projects uses the same pool.
        </Text>
        <Text size="xs" c="dimmed" mt="sm">
          {reading.source} ·{" "}
          {reading.observed_at
            ? new Date(reading.observed_at).toLocaleString()
            : "Time unavailable"}
          {reading.cached ? " · Cached reading" : ""}
        </Text>
        {reading.quota.ordinary_usage_allowed === false && (
          <Alert color="orange" mt="md">
            The native account reports that ordinary usage is unavailable.
          </Alert>
        )}
        <Stack mt="lg">
          {(reading.quota.buckets || []).map((bucket) => (
            <Paper key={bucket.id} withBorder p="md">
              <Text size="sm" fw={600} mb="md">
                {bucket.name || bucket.id}
              </Text>
              <SimpleGrid cols={{ base: 1, sm: 2 }}>
                {[bucket.primary, bucket.secondary].map((window, i) => (
                  <div key={i}>
                    <Text size="xs" c="dimmed" mb="xs">
                      {i === 0 ? "Primary window" : "Secondary window"}
                      {window?.window_duration_minutes
                        ? ` · ${window.window_duration_minutes >= 60 ? `${window.window_duration_minutes / 60} hours` : `${window.window_duration_minutes} minutes`}`
                        : ""}
                    </Text>
                    {window?.remaining_percent !== null &&
                    window?.remaining_percent !== undefined ? (
                      <>
                        <Group justify="space-between" mb="xs">
                          <Text size="sm" fw={600}>
                            {Math.round(window.remaining_percent)}% remaining
                          </Text>
                          <Text size="xs" c="dimmed">
                            {window.used_percent === null
                              ? ""
                              : `${Math.round(window.used_percent)}% used`}
                          </Text>
                        </Group>
                        <Progress
                          value={Math.max(
                            0,
                            Math.min(100, window.remaining_percent),
                          )}
                          aria-label={`${bucket.name || bucket.id} ${i === 0 ? "primary" : "secondary"} quota remaining`}
                        />
                      </>
                    ) : (
                      <Text size="sm" c="dimmed">
                        Unknown
                      </Text>
                    )}
                    {window?.resets_at && (
                      <Text size="xs" c="dimmed" mt="xs">
                        Resets{" "}
                        {new Date(window.resets_at * 1000).toLocaleString()}
                      </Text>
                    )}
                  </div>
                ))}
              </SimpleGrid>
            </Paper>
          ))}
          {!reading.quota.buckets?.length && (
            <Text size="sm" c="dimmed">
              No quota windows were returned.
            </Text>
          )}
        </Stack>
      </Paper>
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <Paper withBorder p="xl" radius="lg">
          <Group justify="space-between">
            <Title order={3}>Account tokens</Title>
            <Badge
              variant="light"
              color={
                reading.account_tokens.status === "actual" ? "teal" : "gray"
              }
            >
              {reading.account_tokens.status}
            </Badge>
          </Group>
          <Text fw={600} size="xl" mt="md">
            {reading.account_tokens.lifetime_tokens === null
              ? "Unknown"
              : reading.account_tokens.lifetime_tokens.toLocaleString()}
          </Text>
          <Text size="sm" c="dimmed" mt="xs">
            {reading.account_tokens.lifetime_tokens === null
              ? "The native account did not supply a total."
              : "Reported lifetime total across the account."}
          </Text>
        </Paper>
        <Paper withBorder p="xl" radius="lg">
          <Group justify="space-between">
            <Title order={3}>Money spent</Title>
            <Badge color="gray" variant="light">
              Unknown
            </Badge>
          </Group>
          <Text size="sm" c="dimmed" mt="md">
            Native token readings do not provide an invoice or subscription
            cost.
          </Text>
          {reading.thread_estimate?.estimated_usd !== null &&
            reading.thread_estimate?.estimated_usd !== undefined && (
              <>
                <Divider my="md" />
                <Text size="sm">
                  Estimated API equivalent: $
                  {reading.thread_estimate.estimated_usd.toFixed(4)}
                </Text>
                <Text size="xs" c="dimmed" mt="xs">
                  {reading.thread_estimate.source}. This is an estimate, not
                  money spent.
                </Text>
              </>
            )}
        </Paper>
      </SimpleGrid>
      <Paper withBorder p="xl" radius="lg">
        <Title order={3}>Registered worker threads</Title>
        <Text size="sm" c="dimmed" mt="sm" mb="lg">
          Native cumulative totals are counted once for each registered thread.
          They cover the thread, and may include work outside this project.
        </Text>
        {reading.registered_threads?.length ? (
          <Stack>
            {reading.registered_threads.map((thread) => (
              <Group key={thread.thread_key} justify="space-between">
                <div>
                  <Text size="sm" ff="monospace">
                    {thread.thread_key}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {thread.source} · {thread.run_ids.join(", ")}
                  </Text>
                </div>
                <Text size="sm">
                  {thread.total_tokens === null
                    ? "Unknown"
                    : `${thread.total_tokens.toLocaleString()} tokens`}
                </Text>
              </Group>
            ))}
          </Stack>
        ) : (
          <Text size="sm" c="dimmed">
            No registered thread totals are available.
          </Text>
        )}
      </Paper>
      {warnings.length > 0 && (
        <Alert color="orange" title="Reading limits">
          <Stack gap="xs">
            {warnings.map((warning, i) => (
              <Text size="sm" key={i}>
                {warning}
              </Text>
            ))}
          </Stack>
        </Alert>
      )}
    </Stack>
  );
}
