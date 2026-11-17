import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  Activity, AlertTriangle, Box, Check, ChevronDown, ChevronRight, CircleHelp,
  Clock3, Command, Cpu, Database, Download, HardDrive, KeyRound,
  LoaderCircle, LockKeyhole, Network, Plus, PlugZap, Power, RefreshCw, Search,
  Server, Settings2, ShieldCheck, Terminal, X,
} from 'lucide-react';

type RecordValue = Record<string, unknown>;
type Pane = 'overview' | 'hardware' | 'discovery' | 'boot';
type Connection = { smdUrl: string; bssUrl: string; smdToken: string; bssToken: string };
type ServiceResult = { status: number; payload: string; contentType: string };
type DiscoveryResult = { inventory: RecordValue[]; target: string; xname: string; discoveredAt: string };

const initialConnection: Connection = { smdUrl: '', bssUrl: '', smdToken: '', bssToken: '' };
const initialBoot = { kernel: '', initrd: '', params: '', mac: '' };

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function parsePayload(result: ServiceResult): unknown {
  if (!result.contentType.includes('json')) return result.payload;
  try { return JSON.parse(result.payload); } catch { return result.payload; }
}

async function callService(request: RecordValue): Promise<ServiceResult> {
  const response = await fetch('/api/service', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
  });
  const envelope = await response.json() as { status?: number; payload?: string; contentType?: string; error?: string };
  if (!response.ok) throw new Error(envelope.error || `Local service proxy returned HTTP ${response.status}`);
  const result = { status: envelope.status || 0, payload: envelope.payload || '', contentType: envelope.contentType || '' };
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`Service returned HTTP ${result.status}: ${result.payload.slice(0, 500)}`);
  }
  return result;
}

async function discover(request: RecordValue): Promise<DiscoveryResult> {
  const response = await fetch('/api/discover', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
  });
  const result = await response.json() as DiscoveryResult & { error?: string };
  if (!response.ok) throw new Error(result.error || `Magellan request failed (HTTP ${response.status})`);
  return result;
}

function endpointId(endpoint: RecordValue, index: number): string {
  return text(endpoint.ID) || text(endpoint.id) || text(endpoint.UUID) || `endpoint-${index + 1}`;
}

function componentRows(value: unknown, path = ''): Array<[string, string]> {
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, item]) => {
    const label = path ? `${path}.${key}` : key;
    if (isRecord(item)) return componentRows(item, label);
    if (Array.isArray(item)) return item.flatMap((child, index) => isRecord(child)
      ? componentRows(child, `${label}[${index}]`)
      : text(child) ? [[`${label}[${index}]`, text(child)] as [string, string]] : []);
    return text(item) ? [[label, text(item)] as [string, string]] : [];
  });
}

function componentsFrom(value: unknown): RecordValue[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (isRecord(value) && Array.isArray(value.ComponentEndpoints)) return value.ComponentEndpoints.filter(isRecord);
  return [];
}

function nodesFrom(value: unknown): RecordValue[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (isRecord(value) && Array.isArray(value.nodes)) return value.nodes.filter(isRecord);
  return [];
}

function nodeName(node: RecordValue): string {
  const spec = isRecord(node.spec) ? node.spec : {};
  const metadata = isRecord(node.metadata) ? node.metadata : {};
  return text(spec.xname) || text(metadata.name);
}

function nodeMac(node: RecordValue): string {
  const spec = isRecord(node.spec) ? node.spec : {};
  return text(spec.bootMac).toLowerCase().replaceAll('-', ':');
}

function scriptParts(script: string) {
  const lines = script.split(/\r?\n/).map((line) => line.trim());
  const kernel = lines.find((line) => /^kernel\s/i.test(line))?.split(/\s+/) || [];
  const initrd = lines.find((line) => /^initrd\s/i.test(line))?.split(/\s+/) || [];
  return { kernel: kernel[1] || '', initrd: initrd[1] || '', params: kernel.slice(2).join(' '), valid: lines[0] === '#!ipxe' && Boolean(kernel[1] && initrd[1] && lines.some((line) => /^boot(?:\s|$)/i.test(line))) };
}

function App() {
  const [pane, setPane] = useState<Pane>('overview');
  const [connection, setConnection] = useState(initialConnection);
  const [draft, setDraft] = useState(initialConnection);
  const [managedAuth, setManagedAuth] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [components, setComponents] = useState<RecordValue[]>([]);
  const [nodes, setNodes] = useState<RecordValue[]>([]);
  const [selectedComponent, setSelectedComponent] = useState('');
  const [selectedNode, setSelectedNode] = useState('');
  const [lastRefresh, setLastRefresh] = useState('');
  const [serviceState, setServiceState] = useState({ smd: 'unknown', bss: 'unknown' });
  const [serviceUpdated, setServiceUpdated] = useState({ smd: '', bss: '' });
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [target, setTarget] = useState('');
  const [xname, setXname] = useState('');
  const [bmcUsername, setBmcUsername] = useState('');
  const [bmcPassword, setBmcPassword] = useState('');
  const [insecure, setInsecure] = useState(true);
  const [discovery, setDiscovery] = useState<DiscoveryResult | null>(null);
  const [discoveryBusy, setDiscoveryBusy] = useState(false);
  const [nodeForm, setNodeForm] = useState({ name: '', mac: '' });
  const [bootForm, setBootForm] = useState(initialBoot);
  const [script, setScript] = useState('');
  const [rawResult, setRawResult] = useState('');
  const [busyAction, setBusyAction] = useState('');
  const [showRaw, setShowRaw] = useState(false);

  const selectedRecord = components.find((component, index) => endpointId(component, index) === selectedComponent);
  const selectedNodeRecord = nodes.find((node) => nodeName(node) === selectedNode);
  const filteredComponents = useMemo(() => components.filter((component, index) => {
    const query = search.trim().toLowerCase();
    return !query || componentRows(component).some(([key, value]) => `${key} ${value}`.toLowerCase().includes(query))
      || endpointId(component, index).toLowerCase().includes(query);
  }), [components, search]);

  useEffect(() => {
    if (!selectedNodeRecord) return;
    const mac = nodeMac(selectedNodeRecord);
    setNodeForm({ name: selectedNode, mac });
    setBootForm((current) => ({ ...current, mac }));
  }, [selectedNode, selectedNodeRecord]);

  useEffect(() => {
    let active = true;
    fetch('/api/config').then(async (response) => {
      if (!response.ok) return undefined;
      return response.json() as Promise<{ smdUrl?: string; bssUrl?: string; managedAuth?: boolean }>;
    }).then((config) => {
      if (!active || !config) return;
      setManagedAuth(config.managedAuth === true);
      if (!config.smdUrl || !config.bssUrl) return;
      const next = { ...initialConnection, smdUrl: config.smdUrl, bssUrl: config.bssUrl };
      setConnection(next);
      setDraft(next);
      if (config.managedAuth) setAutoRefresh(true);
      void refreshAll(next);
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  async function refreshAll(nextConnection = connection) {
    setLoading(true);
    setError('');
    const requests = await Promise.allSettled([
      callService({ operation: 'smd.components', smdUrl: nextConnection.smdUrl, token: nextConnection.smdToken }),
      callService({ operation: 'bss.nodes', bssUrl: nextConnection.bssUrl, token: nextConnection.bssToken }),
    ]);
    let smdSuccess = false;
    let bssSuccess = false;
    const failures: string[] = [];
    if (requests[0].status === 'fulfilled') {
      const next = componentsFrom(parsePayload(requests[0].value));
      setComponents(next);
      setSelectedComponent((current) => next.some((entry, index) => endpointId(entry, index) === current) ? current : next[0] ? endpointId(next[0], 0) : '');
      setServiceState((current) => ({ ...current, smd: 'online' }));
      setServiceUpdated((current) => ({ ...current, smd: new Date().toISOString() }));
      smdSuccess = true;
    } else {
      setServiceState((current) => ({ ...current, smd: 'error' }));
      failures.push(`SMD: ${requests[0].reason instanceof Error ? requests[0].reason.message : 'unavailable'}`);
    }
    if (requests[1].status === 'fulfilled') {
      const next = nodesFrom(parsePayload(requests[1].value));
      setNodes(next);
      setSelectedNode((current) => current && next.some((entry) => nodeName(entry) === current) ? current : next[0] ? nodeName(next[0]) : '');
      setServiceState((current) => ({ ...current, bss: 'online' }));
      setServiceUpdated((current) => ({ ...current, bss: new Date().toISOString() }));
      bssSuccess = true;
    } else {
      setServiceState((current) => ({ ...current, bss: 'error' }));
      failures.push(`BSS: ${requests[1].reason instanceof Error ? requests[1].reason.message : 'unavailable'}`);
    }
    setLastRefresh(new Date().toISOString());
    setError(failures.join(' '));
    setMessage(smdSuccess || bssSuccess ? 'Service status refreshed.' : 'No services responded. Check the connection settings.');
    setLoading(false);
    return smdSuccess || bssSuccess;
  }

  useEffect(() => {
    if (!autoRefresh || !connection.smdUrl || !connection.bssUrl) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshAll(connection);
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [autoRefresh, connection]);

  async function saveConnection(event: FormEvent) {
    event.preventDefault();
    setConnection(draft);
    setSettingsOpen(false);
    await refreshAll(draft);
  }

  async function runDiscovery(event: FormEvent) {
    event.preventDefault();
    setDiscoveryBusy(true);
    setError('');
    setDiscovery(null);
    setMessage('Magellan is scanning the BMC and collecting inventory.');
    setRawResult('');
    try {
      const result = await discover({ target, xname, username: bmcUsername, password: bmcPassword, insecure });
      setDiscovery(result);
      setMessage(`Magellan returned ${result.inventory.length} BMC endpoint record${result.inventory.length === 1 ? '' : 's'}. Nothing has been sent to SMD.`);
      setBmcPassword('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Magellan discovery failed.');
      setMessage('Discovery did not complete.');
    } finally { setDiscoveryBusy(false); }
  }

  async function importEndpoint(endpoint: RecordValue) {
    if (!window.confirm('Send this discovered endpoint to SMD? This will write inventory to the connected cluster.')) return;
    const result = await runAction('smd.import', { smdUrl: connection.smdUrl, token: connection.smdToken, payload: endpoint }, 'SMD import');
    if (result) await refreshAll();
  }

  async function saveNode(event: FormEvent) {
    event.preventDefault();
    const existing = nodes.find((node) => nodeName(node) === nodeForm.name.trim());
    const payload = existing || {
      apiVersion: 'boot.openchami.io/v1', kind: 'Node', metadata: { name: nodeForm.name.trim() },
      spec: { xname: nodeForm.name.trim(), bootMac: nodeForm.mac.trim().toLowerCase() },
    };
    if (existing) {
      const currentSpec = isRecord(existing.spec) ? existing.spec : {};
      const nextPayload = { ...existing, spec: { ...currentSpec, bootMac: nodeForm.mac.trim().toLowerCase() } };
      const metadata = isRecord(existing.metadata) ? existing.metadata : {};
      if (!window.confirm(`Update BSS node ${nodeForm.name.trim()} (${text(metadata.uid) || 'UID unavailable'})?`)) return;
      const result = await runAction('bss.node.update', { bssUrl: connection.bssUrl, token: connection.bssToken, uid: text(metadata.uid), payload: nextPayload }, 'BSS node update');
      if (result) await refreshAll();
    } else {
      if (!window.confirm(`Register ${nodeForm.name.trim()} with boot MAC ${nodeForm.mac.trim()} in BSS?`)) return;
      const result = await runAction('bss.node.create', { bssUrl: connection.bssUrl, token: connection.bssToken, payload }, 'BSS node registration');
      if (result) await refreshAll();
    }
  }

  async function saveBootParameters(event: FormEvent) {
    event.preventDefault();
    const host = selectedNode || nodeForm.name.trim();
    if (!host) { setError('Choose or register a BSS node before setting boot parameters.'); return; }
    const payload = { hosts: [host], macs: bootForm.mac ? [bootForm.mac.trim().toLowerCase()] : [], kernel: bootForm.kernel.trim(), initrd: bootForm.initrd.trim(), params: bootForm.params.trim() };
    if (!window.confirm(`Write boot parameters for ${host} to BSS?`)) return;
    await runAction('bss.bootparameters', { bssUrl: connection.bssUrl, token: connection.bssToken, payload }, 'Boot parameter update');
  }

  async function lookupScript(identifierType: 'host' | 'mac', identifier: string) {
    if (!identifier.trim()) { setError(`Enter a ${identifierType === 'host' ? 'node name' : 'MAC address'} first.`); return; }
    const result = await runAction('bss.bootscript', { bssUrl: connection.bssUrl, identifierType, identifier }, `${identifierType} iPXE lookup`);
    if (result) setScript(result.payload);
  }

  async function runAction(operation: string, request: RecordValue, label: string): Promise<ServiceResult | undefined> {
    setBusyAction(label);
    setError('');
    setMessage(`${label} in progress.`);
    try {
      const result = await callService({ operation, ...request });
      setRawResult(result.payload);
      setMessage(`${label} completed (HTTP ${result.status}).`);
      if (operation === 'bss.bootparameters') setScript('');
      if (operation === 'bss.bootscript') setScript(result.payload);
      return result;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : `${label} failed.`);
      setMessage(`${label} failed.`);
      return undefined;
    } finally { setBusyAction(''); }
  }

  function selectNode(name: string) {
    const node = nodes.find((item) => nodeName(item) === name);
    setSelectedNode(name);
    setNodeForm({ name, mac: node ? nodeMac(node) : '' });
    setBootForm((current) => ({ ...current, mac: node ? nodeMac(node) : current.mac }));
  }

  const serviceConnected = serviceState.smd === 'online' || serviceState.bss === 'online';

  return (
    <div className="console-shell">
      <aside className="rail">
        <a className="brand-lockup" href="#overview" aria-label="OpenCHAMI console"><span className="brand-icon"><Command size={17} /></span><span>open<span>chami</span></span></a>
        <div className="rail-label">WORKSPACE</div>
        <nav className="primary-nav" aria-label="Main navigation">
          <NavButton active={pane === 'overview'} icon={<Activity size={17} />} label="Overview" onClick={() => setPane('overview')} />
          <NavButton active={pane === 'hardware'} icon={<HardDrive size={17} />} label="Hardware" count={components.length || undefined} onClick={() => setPane('hardware')} />
          <NavButton active={pane === 'discovery'} icon={<Network size={17} />} label="Discovery" onClick={() => setPane('discovery')} />
          <NavButton active={pane === 'boot'} icon={<Cpu size={17} />} label="Boot & nodes" count={nodes.length || undefined} onClick={() => setPane('boot')} />
        </nav>
        <div className="rail-bottom">
          <div className={`service-state ${serviceConnected ? 'service-up' : ''}`}><i />{serviceConnected ? 'CONNECTED' : 'NOT CONNECTED'}</div>
          <button className="rail-settings" onClick={() => { setDraft(connection); setSettingsOpen(true); }}><Settings2 size={16} /> Connection settings</button>
          <span className="rail-version">OPENCHAMI CONSOLE <b>0.2</b></span>
        </div>
      </aside>

      <main className="main-area" id="overview">
        <header className="command-bar">
          <div className="breadcrumbs"><span>CLUSTER</span><ChevronRight size={14} /><strong>{paneTitle(pane)}</strong></div>
          <div className="command-actions">
            <label className="auto-refresh"><input type="checkbox" checked={autoRefresh} disabled={!connection.smdUrl || !connection.bssUrl} onChange={(event) => setAutoRefresh(event.target.checked)} /><span>Auto · 30s</span></label>
            {lastRefresh && <span className="last-check"><Clock3 size={13} /> Checked {new Date(lastRefresh).toLocaleTimeString()}</span>}
            <button className="icon-btn" aria-label="Refresh cluster state" title="Refresh SMD and BSS" disabled={loading || !connection.smdUrl || !connection.bssUrl} onClick={() => void refreshAll()}>{loading ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}</button>
            <button className="connect-btn" onClick={() => { setDraft(connection); setSettingsOpen(true); }}><PlugZap size={15} />{connection.smdUrl ? 'Connection' : 'Connect services'}</button>
          </div>
        </header>

        <div className="content-area">
          <div className="page-heading">
            <div><p className="overline">OPENCHAMI / CLUSTER CONTROL</p><h1>{paneTitle(pane)}</h1><p className="page-description">{paneDescription(pane)}</p></div>
            {pane === 'hardware' && <button className="primary-btn" onClick={() => setPane('discovery')}><Network size={15} /> Discover hardware</button>}
            {pane === 'boot' && <button className="primary-btn" onClick={() => { setNodeForm({ name: '', mac: '' }); setSelectedNode(''); document.getElementById('node-editor')?.scrollIntoView({ behavior: 'smooth' }); }}><Plus size={15} /> Register node</button>}
          </div>

          {(message || error) && <div className={`flash-message ${error ? 'flash-error' : 'flash-success'}`} role="status">{error ? <AlertTriangle size={16} /> : <Check size={16} />}<span>{error || message}</span><button aria-label="Dismiss message" onClick={() => { setMessage(''); setError(''); }}><X size={15} /></button></div>}

          {pane === 'overview' && <Overview components={components} nodes={nodes} lastRefresh={lastRefresh} serviceUpdated={serviceUpdated} connected={serviceConnected} serviceState={serviceState} onHardware={() => setPane('hardware')} onDiscovery={() => setPane('discovery')} onBoot={() => setPane('boot')} onConnect={() => { setDraft(connection); setSettingsOpen(true); }} />}
          {pane === 'hardware' && <HardwarePane components={filteredComponents} allCount={components.length} selected={selectedRecord} search={search} setSearch={setSearch} selectedId={selectedComponent} setSelected={(id) => setSelectedComponent(id)} onImport={() => setPane('discovery')} />}
          {pane === 'discovery' && <DiscoveryPane target={target} setTarget={setTarget} xname={xname} setXname={setXname} username={bmcUsername} setUsername={setBmcUsername} password={bmcPassword} setPassword={setBmcPassword} insecure={insecure} setInsecure={setInsecure} result={discovery} busy={discoveryBusy} onSubmit={runDiscovery} onImport={importEndpoint} busyAction={busyAction} />}
          {pane === 'boot' && <BootPane nodes={nodes} selectedNode={selectedNode} selectedNodeRecord={selectedNodeRecord} selectNode={selectNode} nodeForm={nodeForm} setNodeForm={setNodeForm} bootForm={bootForm} setBootForm={setBootForm} onSaveNode={saveNode} onSaveBoot={saveBootParameters} onLookup={lookupScript} script={script} busyAction={busyAction} rawResult={rawResult} />}
        </div>
        <footer className="main-footer"><span><ShieldCheck size={14} /> Actions are sent to the configured cluster services.</span><button onClick={() => setShowRaw((value) => !value)}><Terminal size={14} />{showRaw ? 'Hide' : 'Show'} last response <ChevronDown size={13} /></button></footer>
        {showRaw && <pre className="raw-response">{rawResult || 'No service response yet.'}</pre>}
      </main>

      {settingsOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false); }}><section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div className="modal-head"><div><span className="modal-kicker">LOCAL CONNECTION</span><h2 id="settings-title">Connect cluster services</h2></div><button className="icon-btn" aria-label="Close settings" onClick={() => setSettingsOpen(false)}><X size={17} /></button></div>
        <p>{managedAuth ? 'The launcher manages temporary TokenSmith credentials on the remote console server. Leave token overrides blank to use them; tokens are never returned to this browser.' : 'Enter local port-forward URLs and separate service tokens. Tokens stay in this tab’s memory and are sent only with requests to their matching service.'}</p>
        <form onSubmit={(event) => void saveConnection(event)}>
          <label>SMD service URL<input required type="url" placeholder="http://127.0.0.1:39101" value={draft.smdUrl} onChange={(event) => setDraft({ ...draft, smdUrl: event.target.value })} /></label>
          <label>SMD bearer token override <small>audience: hsm</small><span className="input-icon"><KeyRound size={15} /><input type="password" autoComplete="off" placeholder={managedAuth ? 'Managed for this session' : 'TokenSmith hsm token'} value={draft.smdToken} onChange={(event) => setDraft({ ...draft, smdToken: event.target.value })} /></span></label>
          <label>BSS service URL<input required type="url" placeholder="http://127.0.0.1:39102" value={draft.bssUrl} onChange={(event) => setDraft({ ...draft, bssUrl: event.target.value })} /></label>
          <label>BSS bearer token override <small>audience: boot-service</small><span className="input-icon"><KeyRound size={15} /><input type="password" autoComplete="off" placeholder={managedAuth ? 'Managed for this session' : 'TokenSmith boot-service token'} value={draft.bssToken} onChange={(event) => setDraft({ ...draft, bssToken: event.target.value })} /></span></label>
          <div className="modal-note"><LockKeyhole size={14} />Local proxy accepts loopback URLs only. Use kubectl port-forward to expose cluster services locally.</div>
          <div className="modal-buttons"><button type="button" className="secondary-btn" onClick={() => setSettingsOpen(false)}>Cancel</button><button className="primary-btn" type="submit" disabled={loading}>{loading ? <LoaderCircle className="spin" size={15} /> : <PlugZap size={15} />} Connect & refresh</button></div>
        </form>
      </section></div>}
    </div>
  );
}

function paneTitle(pane: Pane) { return ({ overview: 'Overview', hardware: 'Hardware inventory', discovery: 'Magellan discovery', boot: 'Boot & node management' })[pane]; }
function paneDescription(pane: Pane) { return ({ overview: 'Service health and current cluster inventory.', hardware: 'Browse components recorded by SMD and inspect reported attributes.', discovery: 'Run Magellan against one BMC. Review results before importing anything into SMD.', boot: 'Manage BSS node records, boot parameters, and generated iPXE scripts.' })[pane]; }

function NavButton({ active, icon, label, count, onClick }: { active: boolean; icon: ReactNode; label: string; count?: number; onClick: () => void }) {
  return <button className={`nav-button ${active ? 'nav-active' : ''}`} aria-label={label} title={label} onClick={onClick}>{icon}<span>{label}</span>{count !== undefined && <b>{count}</b>}</button>;
}

function Overview({ components, nodes, lastRefresh, serviceUpdated, connected, serviceState, onHardware, onDiscovery, onBoot, onConnect }: { components: RecordValue[]; nodes: RecordValue[]; lastRefresh: string; serviceUpdated: { smd: string; bss: string }; connected: boolean; serviceState: { smd: string; bss: string }; onHardware: () => void; onDiscovery: () => void; onBoot: () => void; onConnect: () => void }) {
  return <>
    <div className="overview-topline"><div><h2>Cluster at a glance</h2><p>{connected ? 'Latest service reads are shown below.' : 'Connect to your local SMD and BSS services to load cluster state.'}</p></div><div className="service-chips"><span className={`connection-chip ${serviceState.smd === 'online' ? 'chip-up' : serviceState.smd === 'error' ? 'chip-error' : ''}`}><i />SMD {serviceState.smd.toUpperCase()}</span><span className={`connection-chip ${serviceState.bss === 'online' ? 'chip-up' : serviceState.bss === 'error' ? 'chip-error' : ''}`}><i />BSS {serviceState.bss.toUpperCase()}</span></div></div>
    {!connected && <div className="connect-callout"><div className="callout-icon"><PlugZap size={19} /></div><div><strong>Connect to an existing OpenCHAMI control plane</strong><p>Start services with the operator, forward SMD and BSS locally, then enter their URLs and tokens.</p></div><button className="primary-btn" onClick={onConnect}>Connect services <ChevronRight size={15} /></button></div>}
    <div className="metric-grid">
      <Metric icon={<Database size={17} />} label="SMD components" value={components.length} foot={serviceUpdated.smd ? `Last response ${new Date(serviceUpdated.smd).toLocaleTimeString()}` : 'No successful inventory read'} tone="green" />
      <Metric icon={<Server size={17} />} label="BSS nodes" value={nodes.length} foot={serviceUpdated.bss ? `Last response ${new Date(serviceUpdated.bss).toLocaleTimeString()}` : 'No successful node read'} tone="blue" />
      <Metric icon={<Power size={17} />} label="Power state" value="Snapshot" foot="Reported facts only; not a live BMC poll" tone="orange" />
    </div>
    <div className="overview-grid">
      <section className="panel recent-panel"><div className="panel-heading"><div><span className="panel-kicker">CURRENT INVENTORY</span><h3>Component endpoints</h3></div><button className="link-button" onClick={onHardware}>Browse inventory <ChevronRight size={14} /></button></div>
        {components.length ? <div className="recent-list">{components.slice(0, 5).map((component, index) => <div className="recent-row" key={endpointId(component, index)}><span className="component-symbol"><HardDrive size={17} /></span><div><strong>{endpointId(component, index)}</strong><small>{findValue(component, /uuid$/i) || 'UUID unavailable'}</small></div><span className="status-origin"><span />SMD</span></div>)}</div> : <EmptyInline title="No SMD inventory loaded" detail="Connect services and refresh, or run Magellan discovery." />}</section>
      <section className="panel actions-panel"><div className="panel-heading"><div><span className="panel-kicker">QUICK ACTIONS</span><h3>Cluster operations</h3></div><Activity size={17} /></div>
        <button className="action-row" onClick={onDiscovery}><span className="action-symbol action-green"><Network size={17} /></span><span><strong>Discover with Magellan</strong><small>Scan a BMC address and collect inventory</small></span><ChevronRight size={15} /></button>
        <button className="action-row" onClick={onBoot}><span className="action-symbol action-blue"><Cpu size={17} /></span><span><strong>Configure node boot</strong><small>Register a node and set boot parameters</small></span><ChevronRight size={15} /></button>
        <div className="refresh-stamp"><Clock3 size={13} />{lastRefresh ? `Last service read ${new Date(lastRefresh).toLocaleString()}` : 'Service read time not available'}</div>
      </section>
    </div>
  </>;
}

function Metric({ icon, label, value, foot, tone }: { icon: ReactNode; label: string; value: string | number; foot: string; tone: string }) {
  return <section className={`metric-card metric-${tone}`}><div className="metric-label">{icon}{label}</div><strong>{value}</strong><span>{foot}</span></section>;
}

function HardwarePane({ components, allCount, selected, search, setSearch, selectedId, setSelected, onImport }: { components: RecordValue[]; allCount: number; selected?: RecordValue; search: string; setSearch: (value: string) => void; selectedId: string; setSelected: (id: string) => void; onImport: () => void }) {
  return <div className="hardware-layout"><section className="panel inventory-panel"><div className="inventory-toolbar"><div className="search-box"><Search size={15} /><input aria-label="Search inventory" placeholder="Search name, UUID, model, MAC..." value={search} onChange={(event) => setSearch(event.target.value)} /></div><span>{components.length} / {allCount} endpoints</span></div>
    {components.length ? <div className="hardware-grid">{components.map((component, index) => {
      const id = endpointId(component, index);
      const model = findValue(component, /(^|\.)(model|modelname)$/i);
      const uuid = findValue(component, /(^|\.)uuid$/i);
      const macs = componentRows(component).filter(([key]) => /(^|\.)(mac|macaddress)$/i.test(key)).map(([, value]) => value);
      return <button className={`hardware-tile ${selectedId === id ? 'tile-selected' : ''}`} key={id} onClick={() => setSelected(id)}><div className="tile-top"><span className="tile-icon"><Server size={18} /></span><span className="tile-source">SMD FACT</span></div><strong className="tile-id">{id}</strong><span className="tile-model">{model || 'Model not reported'}</span><div className="tile-meta"><span><CircleHelp size={12} />{uuid ? uuid.slice(0, 18) : 'UUID unavailable'}</span><span><Network size={12} />{macs.length || 0} NIC{macs.length === 1 ? '' : 's'}</span></div></button>;
    })}</div> : <EmptyInline title={allCount ? 'No matching hardware' : 'No SMD components yet'} detail={allCount ? 'Try another search.' : 'Connect SMD or run a discovery. Magellan results remain separate until imported.'} />}
    </section>
    <section className="panel detail-panel"><div className="panel-heading"><div><span className="panel-kicker">COMPONENT DETAILS</span><h3>{selected ? endpointId(selected, components.indexOf(selected)) : 'Select hardware'}</h3></div><Database size={17} /></div>
      {selected ? <><div className="detail-origin"><span /> SMD ComponentEndpoints response</div><div className="attribute-list">{componentRows(selected).map(([key, value]) => <div className="attribute-row" key={key}><span>{key}</span><strong>{value}</strong></div>)}</div></> : <EmptyInline title="Choose a component" detail="Attributes returned by SMD will appear here." />}
      <button className="secondary-btn import-link" onClick={onImport}><Download size={14} /> Review Magellan results</button>
    </section></div>;
}

function DiscoveryPane({ target, setTarget, xname, setXname, username, setUsername, password, setPassword, insecure, setInsecure, result, busy, onSubmit, onImport, busyAction }: { target: string; setTarget: (value: string) => void; xname: string; setXname: (value: string) => void; username: string; setUsername: (value: string) => void; password: string; setPassword: (value: string) => void; insecure: boolean; setInsecure: (value: boolean) => void; result: DiscoveryResult | null; busy: boolean; onSubmit: (event: FormEvent) => void; onImport: (endpoint: RecordValue) => void; busyAction: string }) {
  return <div className="discovery-layout"><section className="panel discovery-form-panel"><div className="panel-heading"><div><span className="panel-kicker">MAGELLAN / REDFISH</span><h3>Discover a BMC</h3></div><Network size={18} /></div><p className="form-intro">Scan one BMC address and collect its reported hardware. The result stays in this browser session until you explicitly import it into SMD.</p>
    <form className="operation-form" onSubmit={onSubmit}><label>BMC IP address<input required inputMode="text" placeholder="172.24.0.3" value={target} onChange={(event) => setTarget(event.target.value)} /><small>Single IPv4 or IPv6 address. Subnet scans are disabled.</small></label><label>Magellan BMC ID / xname<input required placeholder="x1000c0s0b0" value={xname} onChange={(event) => setXname(event.target.value)} /><small>Used in the demo’s BMC ID mapping. This is a label, not a discovered fact.</small></label><div className="field-pair"><label>BMC username<input required autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} /></label><label>BMC password<input required type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label></div><label className="toggle-row"><input type="checkbox" checked={insecure} onChange={(event) => setInsecure(event.target.checked)} /><span><b>Skip BMC TLS certificate verification</b><small>Matches the reference demo’s --insecure option. Use only on trusted lab networks.</small></span></label><div className="credential-note"><LockKeyhole size={14} /><span>Credentials are passed to Magellan via a temporary encrypted secrets file and removed after collection. Discovery does not import to SMD.</span></div><button className="primary-btn discover-button" type="submit" disabled={busy}>{busy ? <><LoaderCircle className="spin" size={16} />Scanning and collecting…</> : <><Network size={16} />Discover with Magellan</>}</button></form>
  </section><section className="panel discovery-results"><div className="panel-heading"><div><span className="panel-kicker">LOCAL DISCOVERY RESULTS</span><h3>{result ? `${result.inventory.length} endpoint${result.inventory.length === 1 ? '' : 's'} collected` : 'Waiting for discovery'}</h3></div>{result && <span className="result-time">{new Date(result.discoveredAt).toLocaleTimeString()}</span>}</div>
    {result?.inventory.length ? <div className="discovery-records">{result.inventory.map((endpoint, index) => <div className="discovery-record" key={endpointId(endpoint, index)}><div className="record-top"><span className="tile-icon"><Server size={17} /></span><div><strong>{endpointId(endpoint, index)}</strong><small>Magellan result · {result.target}</small></div><span className="origin-tag origin-magellan">LOCAL RESULT</span></div><div className="record-facts">{componentRows(endpoint).slice(0, 8).map(([key, value]) => <div key={key}><span>{key}</span><b>{value}</b></div>)}</div><button className="primary-btn import-button" onClick={() => void onImport(endpoint)} disabled={Boolean(busyAction)}><Download size={14} />{busyAction === 'SMD import' ? 'Importing…' : 'Import this endpoint to SMD'}</button></div>)}</div> : <div className="discovery-empty"><div className="radar-icon"><Network size={21} /></div><strong>{busy ? 'Magellan is working' : 'No discovery results yet'}</strong><p>{busy ? 'Scanning the BMC and collecting Redfish inventory. This can take a little while.' : 'Enter a BMC address and credentials to run a real scan. No sample inventory is shown.'}</p><div className="discovery-sequence"><span>01 SCAN</span><ChevronRight size={13} /><span>02 COLLECT</span><ChevronRight size={13} /><span>03 REVIEW</span><ChevronRight size={13} /><span>04 IMPORT</span></div></div>}
    {result && !result.inventory.length && <div className="empty-inline"><strong>Magellan returned no endpoints.</strong><span>Check the BMC address, TLS setting, credentials, and network route.</span></div>}
  </section></div>;
}

function BootPane({ nodes, selectedNode, selectedNodeRecord, selectNode, nodeForm, setNodeForm, bootForm, setBootForm, onSaveNode, onSaveBoot, onLookup, script, busyAction, rawResult }: { nodes: RecordValue[]; selectedNode: string; selectedNodeRecord?: RecordValue; selectNode: (name: string) => void; nodeForm: { name: string; mac: string }; setNodeForm: (value: { name: string; mac: string }) => void; bootForm: { kernel: string; initrd: string; params: string; mac: string }; setBootForm: (value: typeof initialBoot) => void; onSaveNode: (event: FormEvent) => void; onSaveBoot: (event: FormEvent) => void; onLookup: (type: 'host' | 'mac', identifier: string) => void; script: string; busyAction: string; rawResult: string }) {
  const parsed = scriptParts(script);
  return (
    <div className="boot-workspace">
      <section className="panel nodes-panel">
        <div className="panel-heading">
          <div><span className="panel-kicker">BOOT SCRIPT SERVICE</span><h3>Registered nodes <small>{nodes.length}</small></h3></div>
          <Server size={17} />
        </div>
        {nodes.length ? <div className="node-list">{nodes.map((node) => {
          const name = nodeName(node) || 'Unnamed node';
          const metadata = isRecord(node.metadata) ? node.metadata : {};
          return <button className={`node-row ${selectedNode === name ? 'node-row-active' : ''}`} key={`${name}-${text(metadata.uid)}`} onClick={() => selectNode(name)}>
            <span className="node-avatar"><Server size={16} /></span>
            <span><b>{name}</b><small>{nodeMac(node) || 'Boot MAC unavailable'}</small></span>
            <ChevronRight size={15} />
          </button>;
        })}</div> : <EmptyInline title="No BSS nodes loaded" detail="Refresh services or register a node below." />}
      </section>

      <section className="panel editor-panel" id="node-editor">
        <div className="panel-heading">
          <div><span className="panel-kicker">NODE RESOURCE</span><h3>{nodes.some((node) => nodeName(node) === nodeForm.name) ? 'Update node' : 'Register node'}</h3></div>
          <Settings2 size={17} />
        </div>
        <form className="operation-form" onSubmit={onSaveNode}>
          <label>Node xname<input required value={nodeForm.name} onChange={(event) => setNodeForm({ ...nodeForm, name: event.target.value })} placeholder="x1000c0s0b0n0" /></label>
          <label>Boot MAC address<input required value={nodeForm.mac} onChange={(event) => setNodeForm({ ...nodeForm, mac: event.target.value })} placeholder="a4:bf:01:3f:6b:40" /></label>
          <p className="form-hint">Creates with POST /nodes or updates the matching resource with PUT /nodes/{'{uid}'}.</p>
          <button className="primary-btn" type="submit" disabled={!nodeForm.name || !nodeForm.mac || Boolean(busyAction)}><Check size={15} />{busyAction === 'BSS node registration' || busyAction === 'BSS node update' ? 'Saving…' : 'Save node'}</button>
        </form>
      </section>

      <section className="panel boot-config-panel">
        <div className="panel-heading">
          <div><span className="panel-kicker">BOOT PARAMETERS</span><h3>Set boot configuration</h3></div>
          <Cpu size={18} />
        </div>
        <form className="operation-form" onSubmit={onSaveBoot}>
          <label>Target node<select value={selectedNode} onChange={(event) => selectNode(event.target.value)}><option value="">Choose a registered node</option>{nodes.map((node) => <option key={nodeName(node)} value={nodeName(node)}>{nodeName(node)}</option>)}</select></label>
          <label>Boot MAC<input value={bootForm.mac} onChange={(event) => setBootForm({ ...bootForm, mac: event.target.value })} placeholder="a4:bf:01:3f:6b:40" /></label>
          <label>Kernel URL<input required value={bootForm.kernel} onChange={(event) => setBootForm({ ...bootForm, kernel: event.target.value })} placeholder="https://…/vmlinuz-lts" /></label>
          <label>Initrd URL<input required value={bootForm.initrd} onChange={(event) => setBootForm({ ...bootForm, initrd: event.target.value })} placeholder="https://…/initramfs-lts" /></label>
          <label>Kernel arguments<textarea rows={3} value={bootForm.params} onChange={(event) => setBootForm({ ...bootForm, params: event.target.value })} placeholder="ip=dhcp …" /></label>
          <div className="warning-note"><AlertTriangle size={14} />Writes BSS boot parameters. The reference demo does not include a read-back endpoint.</div>
          <button className="primary-btn" type="submit" disabled={!selectedNode || Boolean(busyAction)}><Check size={15} />{busyAction === 'Boot parameter update' ? 'Writing…' : 'Write boot parameters'}</button>
        </form>
      </section>

      <section className="panel script-panel">
        <div className="panel-heading">
          <div><span className="panel-kicker">GENERATED RESPONSE</span><h3>iPXE boot script</h3></div>
          <Terminal size={17} />
        </div>
        <div className="lookup-row">
          <button className="secondary-btn" disabled={!selectedNode} onClick={() => void onLookup('host', selectedNode)}><Search size={14} />Lookup by host</button>
          <button className="secondary-btn" disabled={!selectedNode || !nodeMac(selectedNodeRecord || {})} onClick={() => void onLookup('mac', nodeMac(selectedNodeRecord || {}))}><Search size={14} />Lookup by MAC</button>
        </div>
        {script && <div className={`script-status ${parsed.valid ? 'script-valid' : 'script-invalid'}`}>
          {parsed.valid ? <Check size={14} /> : <AlertTriangle size={14} />}
          {parsed.valid ? 'BSS returned a script containing kernel, initrd and boot.' : 'Response received but does not match expected iPXE form.'} Physical boot is not verified.
        </div>}
        <pre className="script-output">{script || 'No iPXE response requested.'}</pre>
        {rawResult && <details className="last-response"><summary>Last BSS response</summary><pre>{rawResult}</pre></details>}
      </section>
    </div>
  );
}

function EmptyInline({ title, detail }: { title: string; detail: string }) { return <div className="empty-inline"><span className="empty-mark"><Box size={18} /></span><strong>{title}</strong><span>{detail}</span></div>; }
function findValue(record: RecordValue, pattern: RegExp): string { return componentRows(record).find(([key]) => pattern.test(key))?.[1] || ''; }

export default App;
