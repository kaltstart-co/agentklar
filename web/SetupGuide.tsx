import { Button, CopyButton, Group } from "@mantine/core";

const installer = "curl -fsSL https://agentklar-seven.vercel.app/install.sh | bash";
export function SetupGuide({ local, onRetry, onSettings }: {
  local: boolean;
  onRetry: () => void;
  onSettings: () => void;
}) {
  return <section className="setup-guide" aria-labelledby="setup-title">
    <div className="setup-intro">
      <span className="setup-kicker">LOCAL WORKSPACE · BETA</span>
      <h2 id="setup-title">{local ? "Connect your workspace" : "Bring your work into view"}</h2>
      <p>Your coding harness stays in charge. AgentKlar keeps projects, worker runs and results together on your computer.</p>
    </div>
    <div className="installer-card">
      <div className="settings-heading">
        <div><h3>Install AgentKlar</h3><p className="hint">macOS or Linux · Uses your existing harnesses</p></div>
        <span className="installer-label">Terminal</span>
      </div>
      <pre className="installer-command"><code>{installer}</code></pre>
      <Group gap="sm" className="setup-actions">
        <CopyButton value={installer}>{({ copied, copy }) => <Button onClick={copy}>{copied ? "Copied" : "Copy install command"}</Button>}</CopyButton>
        {local && <Button variant="light" onClick={onRetry}>Try connection again</Button>}
      </Group>
      <p className="hint installer-next">Paste this into your terminal. Follow the installer, then open the local setup link it prints.</p>
    </div>
    <div className="setup-secondary">
      <details className="settings-disclosure"><summary>Start at login on macOS</summary>
        <div className="disclosure-body"><p className="hint">After installing, stop the foreground service first. Keep your custom home and port, if set.</p>
          <pre>agentklar service install{"\n"}agentklar service open</pre>
          <p className="hint">Each setup link works once for five minutes.</p>
        </div>
      </details>
      <details className="settings-disclosure"><summary>Use a source checkout</summary>
        <div className="disclosure-body"><pre>npm ci{"\n"}npm run build{"\n"}npm start</pre></div>
      </details>
      <details className="settings-disclosure"><summary>Connect your coding harness</summary>
        <div className="disclosure-body"><p className="hint">Open the local app and use Settings → Native connection to preview and add AgentKlar to your harness. Native sign-in and permissions stay in place.</p>
          <Group><Button variant="light" onClick={onSettings}>Open connection settings</Button></Group>
        </div>
      </details>
    </div>
    <p className="setup-footnote">{local ? "Open the one-time link from your terminal to give this browser a local session." : "This page is an install guide. Your projects and approvals appear in the local app."}</p>
  </section>;
}
