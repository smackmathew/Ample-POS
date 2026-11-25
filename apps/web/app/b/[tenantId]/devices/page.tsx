import { ActionForm } from '@/components/action-form';
import { api } from '@/lib/api';
import { formatDateTime, homeTimeZone } from '@/lib/time';
import type { Device, Location, Printer, Scanner } from '@/lib/types';
import { registerDevice, revokeDevice } from '../actions';
import { addPrinter, addScanner, assignPrinter, assignScanner, removePrinter, removeScanner } from '../printer-actions';

const CONNECTION: Record<Printer['connection'], string> = { usb: 'USB', network_share: 'Network share', ip: 'IP address' };
const SCANNER_CONNECTION: Record<Scanner['connection'], string> = { usb: 'USB', bluetooth: 'Bluetooth', serial: 'Serial / COM port' };
const LANGUAGE: Record<Printer['language'], string> = {
  escpos: 'ESC/POS',
  star: 'Star',
  zpl: 'ZPL (Zebra)',
  epl: 'EPL (older Zebra)',
  tspl: 'TSPL (TSC, Rollo and most thermal label printers)',
  system: 'System print dialog',
};
const KIND = {
  receipt: {
    title: 'Receipt printers',
    blurb: 'Print sales receipts. Each register has its own.',
    languages: ['escpos', 'star', 'system'] as Printer['language'][],
    paper: ['80mm', '58mm'],
  },
  tag: {
    title: 'Tag printers',
    blurb: 'Print price tags and shelf or product labels. Shared by every device at the location.',
    languages: ['zpl', 'tspl', 'epl', 'system'] as Printer['language'][],
    paper: ['2x1in', '1.25x1in', '2.25x1.25in', '4x6in'],
  },
} as const;

export default async function DevicesPage({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;
  const [devices, locations, printers, scanners] = await Promise.all([
    api<Device[]>('/devices', { tenantId }),
    api<Location[]>('/locations', { tenantId }),
    api<Printer[]>('/printers', { tenantId }),
    api<Scanner[]>('/scanners', { tenantId }),
  ]);
  const locationName = new Map(locations.map((l) => [l.id, l.name]));
  const zone = homeTimeZone(locations);
  const registers = devices.filter((d) => d.kind === 'register');
  const others = devices.filter((d) => d.kind !== 'register');
  const activeRegisters = registers.filter((d) => d.status === 'active');
  const activeDevices = devices.filter((d) => d.status === 'active');
  const receiptPrinter = (registerId: string) => printers.find((p) => p.registerId === registerId && p.kind === 'receipt');
  const scannersOf = (deviceId: string) => {
    const list = scanners.filter((sc) => sc.deviceId === deviceId).map((sc) => sc.name);
    return list.length ? list.join(', ') : <span className="text-stone-400">None</span>;
  };

  return (
    <div className="max-w-5xl space-y-10">
      <h1 className="text-2xl font-semibold">Devices</h1>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Registers</h2>
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="bg-stone-50 text-left text-stone-500">
              <tr>
                <th className="px-5 py-3 font-medium">Register</th>
                <th className="px-5 py-3 font-medium">Location</th>
                <th className="px-5 py-3 font-medium">Receipt printer</th>
                <th className="px-5 py-3 font-medium">Scanners</th>
                <th className="px-5 py-3 font-medium">Last seen</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {registers.map((d) => (
                <tr key={d.id} className={d.status === 'revoked' ? 'text-stone-400' : ''}>
                  <td className="px-5 py-3 font-medium">{d.name}</td>
                  <td className="px-5 py-3">{locationName.get(d.locationId) ?? '—'}</td>
                  <td className="px-5 py-3">{d.status === 'active' ? (receiptPrinter(d.id)?.name ?? <span className="text-stone-400">None</span>) : '—'}</td>
                  <td className="px-5 py-3">{d.status === 'active' ? scannersOf(d.id) : '—'}</td>
                  <td className="px-5 py-3 text-stone-500">
                    {d.status === 'revoked' ? 'Revoked' : d.lastSeenAt ? formatDateTime(d.lastSeenAt, zone) : 'Not yet'}
                  </td>
                  <td className="px-5 py-3 text-right">
                    {d.status === 'active' && (
                      <form action={revokeDevice.bind(null, tenantId, d.id)}>
                        <button className="text-xs text-red-700 hover:underline">Revoke</button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
              {registers.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-5 py-6 text-stone-500">
                    No registers yet. Add one below, then pair it with the Ample POS app.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {others.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Handhelds & kiosks</h2>
          <div className="card overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead className="bg-stone-50 text-left text-stone-500">
                <tr>
                  <th className="px-5 py-3 font-medium">Name</th>
                  <th className="px-5 py-3 font-medium">Type</th>
                  <th className="px-5 py-3 font-medium">Location</th>
                  <th className="px-5 py-3 font-medium">Scanners</th>
                  <th className="px-5 py-3 font-medium">Last seen</th>
                  <th className="px-5 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {others.map((d) => (
                  <tr key={d.id} className={d.status === 'revoked' ? 'text-stone-400' : ''}>
                    <td className="px-5 py-3 font-medium">{d.name}</td>
                    <td className="px-5 py-3 capitalize">{d.kind}</td>
                    <td className="px-5 py-3">{locationName.get(d.locationId) ?? '—'}</td>
                    <td className="px-5 py-3">{d.status === 'active' ? scannersOf(d.id) : '—'}</td>
                    <td className="px-5 py-3 text-stone-500">
                      {d.status === 'revoked' ? 'Revoked' : d.lastSeenAt ? formatDateTime(d.lastSeenAt, zone) : 'Not yet'}
                    </td>
                    <td className="px-5 py-3 text-right">
                      {d.status === 'active' && (
                        <form action={revokeDevice.bind(null, tenantId, d.id)}>
                          <button className="text-xs text-red-700 hover:underline">Revoke</button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {locations.length === 0 ? (
        <p className="text-sm text-stone-600">Add a location before registering devices or printers.</p>
      ) : (
        <ActionForm
          action={registerDevice.bind(null, tenantId)}
          className="card grid gap-3 sm:grid-cols-3"
          secretLabel="Pair the device now. This code will not be shown again."
        >
          <h3 className="font-semibold sm:col-span-3">Add a register or handheld</h3>
          <input name="name" placeholder="Register 1" required className="input" />
          <select name="kind" className="input" aria-label="Type">
            <option value="register">Register</option>
            <option value="handheld">Handheld</option>
            <option value="kiosk">Kiosk</option>
          </select>
          <select name="locationId" className="input" aria-label="Location">
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
          <button className="btn sm:col-span-3 sm:justify-self-start">Add device</button>
        </ActionForm>
      )}

      {locations.length > 0 && (
        <section className="space-y-6">
          <div>
            <h2 className="text-lg font-semibold">Printers</h2>
            <p className="mt-1 max-w-3xl text-sm text-stone-600">
              Connect printers by USB (plugged into the register), a network share (shared from a computer) or an IP address (a printer on your network). Give
              each register its own receipt printer; tag printers are shared by every device at their location.
            </p>
          </div>
          {(['receipt', 'tag'] as const).map((kind) => (
            <PrinterSection
              key={kind}
              tenantId={tenantId}
              kind={kind}
              printers={printers.filter((p) => p.kind === kind)}
              locations={locations}
              registers={activeRegisters}
              locationName={locationName}
            />
          ))}
        </section>
      )}

      {locations.length > 0 && (
        <ScannerSection tenantId={tenantId} scanners={scanners} locations={locations} devices={activeDevices} locationName={locationName} />
      )}
    </div>
  );
}

function PrinterSection({
  tenantId,
  kind,
  printers,
  locations,
  registers,
  locationName,
}: {
  tenantId: string;
  kind: Printer['kind'];
  printers: Printer[];
  locations: Location[];
  registers: Device[];
  locationName: Map<string, string>;
}) {
  const k = KIND[kind];
  return (
    <div className="card space-y-4">
      <div>
        <h3 className="font-semibold">{k.title}</h3>
        <p className="text-sm text-stone-500">{k.blurb}</p>
      </div>
      {printers.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-stone-200">
          <table className="w-full text-sm">
            <thead className="bg-stone-50 text-left text-stone-500">
              <tr>
                <th className="px-4 py-2 font-medium">Printer</th>
                <th className="px-4 py-2 font-medium">Connection</th>
                {kind === 'receipt' && <th className="px-4 py-2 font-medium">Register</th>}
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {printers.map((p) => (
                <tr key={p.id} className="align-top">
                  <td className="px-4 py-3">
                    <div className="font-medium">{p.name}</div>
                    <div className="text-xs text-stone-500">
                      {locationName.get(p.locationId)} · {LANGUAGE[p.language].split(' (')[0]}
                      {p.paper ? ` · ${p.paper}` : ''}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {CONNECTION[p.connection]}
                    {p.address && (
                      <code className="block text-xs break-all text-stone-500">
                        {p.address}
                        {p.connection === 'ip' && p.port ? `:${p.port}` : ''}
                      </code>
                    )}
                  </td>
                  {kind === 'receipt' && (
                    <td className="px-4 py-3">
                      <ActionForm action={assignPrinter.bind(null, tenantId, p.id)} className="flex flex-wrap items-center gap-2">
                        <select name="registerId" defaultValue={p.registerId ?? ''} className="input w-44 py-1.5" aria-label={`Register for ${p.name}`}>
                          <option value="">Not assigned</option>
                          {registers
                            .filter((r) => r.locationId === p.locationId)
                            .map((r) => (
                              <option key={r.id} value={r.id}>
                                {r.name}
                              </option>
                            ))}
                        </select>
                        <button className="btn-secondary px-2.5 py-1.5 text-xs">Save</button>
                      </ActionForm>
                    </td>
                  )}
                  <td className="px-4 py-3 text-right">
                    <form action={removePrinter.bind(null, tenantId, p.id)}>
                      <button className="text-xs text-red-700 hover:underline">Remove</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <details className="rounded-xl border border-dashed border-stone-300 p-4" open={printers.length === 0}>
        <summary className="cursor-pointer text-sm font-medium text-brand">Add a {kind} printer</summary>
        <ActionForm action={addPrinter.bind(null, tenantId, kind)} className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className="block text-sm">
            Name
            <input name="name" required maxLength={60} placeholder={kind === 'receipt' ? 'Front counter' : 'Price tags'} className="input mt-1" />
          </label>
          <label className="block text-sm">
            Location
            <select name="locationId" className="input mt-1">
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
          {kind === 'receipt' && (
            <label className="block text-sm">
              Register (optional)
              <select name="registerId" className="input mt-1" defaultValue="">
                <option value="">Not assigned</option>
                {registers.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} ({locationName.get(r.locationId)})
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="block text-sm">
            Connection
            <select name="connection" className="input mt-1" defaultValue="ip">
              <option value="ip">IP address</option>
              <option value="network_share">Network share</option>
              <option value="usb">USB</option>
            </select>
          </label>
          <label className="block text-sm sm:col-span-1 lg:col-span-1">
            Address
            <input name="address" maxLength={255} placeholder="192.168.1.50 or \\FRONT-PC\Printer" className="input mt-1" />
          </label>
          <label className="block text-sm">
            Port (IP only)
            <input name="port" inputMode="numeric" placeholder="9100" className="input mt-1" />
          </label>
          <label className="block text-sm">
            Printer language
            <select name="language" className="input mt-1">
              {k.languages.map((l) => (
                <option key={l} value={l}>
                  {LANGUAGE[l]}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            {kind === 'receipt' ? 'Paper width' : 'Tag size'}
            <select name="paper" className="input mt-1">
              {k.paper.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
          <p className="text-xs text-stone-500 sm:col-span-2 lg:col-span-3">
            <strong>IP address:</strong> the printer’s address on your network, port 9100 for most printers. <strong>Network share:</strong> the path of a
            printer shared from a computer, like <code>\\FRONT-PC\Receipt</code>. <strong>USB:</strong> plugged into the register; the address can stay empty or
            hold the printer’s name.
          </p>
          <button className="btn justify-self-start sm:col-span-2 lg:col-span-3">Add printer</button>
        </ActionForm>
      </details>
    </div>
  );
}

function ScannerSection({
  tenantId,
  scanners,
  locations,
  devices,
  locationName,
}: {
  tenantId: string;
  scanners: Scanner[];
  locations: Location[];
  devices: Device[];
  locationName: Map<string, string>;
}) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold">Barcode scanners</h2>
        <p className="mt-1 max-w-3xl text-sm text-stone-600">
          Symbol (Zebra) and other scanners, attached to any device: registers, handhelds or kiosks. A device can have more than one.
        </p>
      </div>
      <div className="card space-y-4">
        {scanners.length > 0 && (
          <div className="overflow-x-auto rounded-xl border border-stone-200">
            <table className="w-full text-sm">
              <thead className="bg-stone-50 text-left text-stone-500">
                <tr>
                  <th className="px-4 py-2 font-medium">Scanner</th>
                  <th className="px-4 py-2 font-medium">Connection</th>
                  <th className="px-4 py-2 font-medium">Device</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {scanners.map((sc) => (
                  <tr key={sc.id} className="align-top">
                    <td className="px-4 py-3">
                      <div className="font-medium">{sc.name}</div>
                      <div className="text-xs text-stone-500">
                        {locationName.get(sc.locationId)}
                        {sc.brand || sc.model ? ` · ${[sc.brand, sc.model].filter(Boolean).join(' ')}` : ''}
                      </div>
                    </td>
                    <td className="px-4 py-3">{SCANNER_CONNECTION[sc.connection]}</td>
                    <td className="px-4 py-3">
                      <ActionForm action={assignScanner.bind(null, tenantId, sc.id)} className="flex flex-wrap items-center gap-2">
                        <select name="deviceId" defaultValue={sc.deviceId ?? ''} className="input w-44 py-1.5" aria-label={`Device for ${sc.name}`}>
                          <option value="">Not attached</option>
                          {devices
                            .filter((d) => d.locationId === sc.locationId)
                            .map((d) => (
                              <option key={d.id} value={d.id}>
                                {d.name}
                              </option>
                            ))}
                        </select>
                        <button className="btn-secondary px-2.5 py-1.5 text-xs">Save</button>
                      </ActionForm>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <form action={removeScanner.bind(null, tenantId, sc.id)}>
                        <button className="text-xs text-red-700 hover:underline">Remove</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <details className="rounded-xl border border-dashed border-stone-300 p-4" open={scanners.length === 0}>
          <summary className="cursor-pointer text-sm font-medium text-brand">Add a scanner</summary>
          <ActionForm action={addScanner.bind(null, tenantId)} className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label className="block text-sm">
              Name
              <input name="name" required maxLength={60} placeholder="Front scanner" className="input mt-1" />
            </label>
            <label className="block text-sm">
              Brand
              <input name="brand" maxLength={40} defaultValue="Symbol" className="input mt-1" />
            </label>
            <label className="block text-sm">
              Model (optional)
              <input name="model" maxLength={60} placeholder="LS2208" className="input mt-1" />
            </label>
            <label className="block text-sm">
              Connection
              <select name="connection" className="input mt-1" defaultValue="usb">
                <option value="usb">USB</option>
                <option value="bluetooth">Bluetooth</option>
                <option value="serial">Serial / COM port</option>
              </select>
            </label>
            <label className="block text-sm">
              Location
              <select name="locationId" className="input mt-1">
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              Device (optional)
              <select name="deviceId" className="input mt-1" defaultValue="">
                <option value="">Not attached</option>
                {devices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} ({locationName.get(d.locationId)})
                  </option>
                ))}
              </select>
            </label>
            <p className="text-xs text-stone-500 sm:col-span-2 lg:col-span-3">
              Most scanners plugged in by USB type the barcode like a keyboard and need no setup. For Bluetooth, pair the scanner with the device first.
            </p>
            <button className="btn justify-self-start sm:col-span-2 lg:col-span-3">Add scanner</button>
          </ActionForm>
        </details>
      </div>
    </section>
  );
}
