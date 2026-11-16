# OpenCHAMI Cluster Console

A local web interface for connecting to an OpenCHAMI control plane that you start and manage separately. The app does not deploy the operator or control plane. It provides cluster status, SMD inventory browsing, Magellan BMC discovery, explicit SMD import, BSS node management, boot-parameter submission, and iPXE lookups.

## Run the Console

Requirements: Node.js 20.19+ and npm.

```sh
npm install
npm run dev
```

Open the local URL printed by Vite, normally `http://127.0.0.1:5173`. To build and serve the production bundle locally:

```sh
npm run build
npm run preview
```

Preview listens on `http://127.0.0.1:4175` by default. Both servers bind to loopback.

## Connect to Your Services

Start the OpenCHAMI services with your operator. Then forward SMD and BSS to local ports. For the reference `operator-demo` service names and ports, run these in separate terminals:

```sh
kubectl port-forward --address 127.0.0.1 -n openchami-testcluster svc/smd 39101:27779
```

```sh
kubectl port-forward --address 127.0.0.1 -n openchami-testcluster svc/boot-service 39102:27778
```

The console connection dialog accepts the resulting local URLs, for example `http://127.0.0.1:39101` and `http://127.0.0.1:39102`, and separate bearer tokens for the SMD `hsm` audience and BSS `boot-service` audience. The demo has no browser login flow; mint tokens using its TokenSmith CLI or use credentials issued by your own cluster. Tokens are held in browser memory only.

For `operator-demo`, mint the two tokens in a terminal and paste each result into its matching field:

```sh
kubectl exec -n openchami-testcluster deploy/tokensmith -- \
	/usr/local/bin/tokensmith user-token create \
	--subject demo-admin --audience hsm \
	--scopes node:read,node:write,group:read,group:write \
	--key-file /var/lib/tokensmith/keys/private.pem \
	--enable-local-user-mint
```

```sh
kubectl exec -n openchami-testcluster deploy/tokensmith -- \
	/usr/local/bin/tokensmith user-token create \
	--subject demo-admin --audience boot-service \
	--scopes boot:read,boot:write,node:read,node:write \
	--key-file /var/lib/tokensmith/keys/private.pem \
	--enable-local-user-mint
```

The local proxy intentionally accepts loopback service URLs only. This avoids turning a browser-accessible local server into a general network proxy. Use `kubectl port-forward` for cluster service access.

## Supported Operations

The API actions follow the commands in `../operator-demo/demo-fresh.sh` and `../operator-demo/demo.sh`:

- Magellan scans one user-entered BMC IP, then collects inventory. The BMC ID/xname mapping and credentials are configurable. Discovery results remain local until you click the separate SMD import action.
- SMD inventory: `GET /hsm/v2/Inventory/ComponentEndpoints`.
- Import a reviewed Redfish endpoint: `POST /hsm/v2/Inventory/RedfishEndpoints`.
- BSS node list/create/update: `GET /nodes`, `POST /nodes`, and `PUT /nodes/{uid}`.
- Set boot parameters: `POST /boot/v1/bootparameters`.
- Retrieve iPXE by node name or MAC: `GET /boot/v1/bootscript?host=...` or `?mac=...`.

Write operations require a user action and confirmation. Discovery never imports automatically. The console does not configure DHCP, reboot nodes, or execute returned boot scripts.

Magellan must be installed on the same machine as the local console server and available on `PATH`; alternatively set `MAGELLAN_BIN` to its executable. BMC credentials are stored briefly in Magellan's encrypted secrets format under a private temporary directory with an ephemeral key; temporary files are removed whether collection succeeds or fails. The `Skip TLS verification` option matches the reference lab demo's `--insecure` behavior and should only be used on a trusted network.

## Interpreting Status

Service reachability means an API responded, not that the physical system is healthy. SMD `ComponentEndpoints` is the inventory currently recorded by SMD and may be a snapshot. Magellan results reflect the most recent discovery run. BSS boot settings are displayed from what the generated iPXE response contains because the demo does not establish a boot-parameter read-back endpoint. A valid host/MAC iPXE response proves script generation only; it does not prove a physical PXE boot.

The UI never inserts sample hardware. Missing fields are shown as unavailable, and data remains labeled by its source.

Use the refresh control for an immediate SMD/BSS read or enable the optional 30-second auto-refresh. Auto-refresh pauses while the browser tab is hidden. Magellan discovery remains a user-triggered operation.

## Checks

```sh
npm test
npm run build
```
