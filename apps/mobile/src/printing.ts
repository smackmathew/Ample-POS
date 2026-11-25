import {
  parseTagSize,
  receiptEscPos,
  receiptHtml,
  receiptStar,
  tagEpl,
  tagHtml,
  tagTspl,
  tagZpl,
  type Receipt,
  type Tag,
} from '@pos/receipts';
import type { ApiClient } from '@pos/sync';
import * as Print from 'expo-print';
import TcpSocket from 'react-native-tcp-socket';
import { getMeta, setMeta } from './db';

/** A printer as GET /device returns it (set up under Devices → Printers in the web hub). */
export interface DevicePrinter {
  id: string;
  name: string;
  kind: 'receipt' | 'tag';
  connection: 'usb' | 'network_share' | 'ip';
  address: string | null;
  port: number | null;
  language: 'escpos' | 'star' | 'zpl' | 'epl' | 'tspl' | 'system';
  paper: string | null;
}

export interface DeviceSetup {
  printers: DevicePrinter[];
  currency: string;
}

const KEY = 'deviceSetup';

/** This device's printers and the business currency, fresh when online, otherwise the last copy. */
export async function loadDeviceSetup(api: ApiClient): Promise<DeviceSetup> {
  try {
    const [device, tenant] = await Promise.all([
      api.get<{ printers?: DevicePrinter[] }>('/device'),
      api.get<{ tenant: { currency: string } }>('/tenant'),
    ]);
    const setup = { printers: device.printers ?? [], currency: tenant.tenant.currency };
    await setMeta(KEY, JSON.stringify(setup));
    return setup;
  } catch (err) {
    const cached = await getMeta(KEY);
    if (cached) return JSON.parse(cached) as DeviceSetup;
    throw err;
  }
}

/** Sends raw printer commands to a network printer (usually port 9100) and waits until they're out. */
export function sendRaw(host: string, port: number, data: Uint8Array | string, timeoutMs = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error(`The printer at ${host} didn’t answer. Check it’s on and on the same network.`)), timeoutMs);
    const socket = TcpSocket.createConnection({ host, port }, () => {
      socket.write(data, undefined, (err) => {
        if (err) return finish(err);
        // Give the printer a moment to take the data before closing.
        socket.end();
        setTimeout(() => finish(), 300);
      });
    });
    socket.on('error', (err) => finish(err instanceof Error ? err : new Error(String(err))));
  });
}

/** Whether the app talks to this printer directly (rather than through the system print dialog). */
export function isDirect(p: DevicePrinter): boolean {
  return p.connection === 'ip' && p.language !== 'system' && Boolean(p.address);
}

/**
 * Prints a receipt on the register's receipt printer: straight to a network
 * printer, or through the system print dialog for USB, shared and "system"
 * printers (and when no printer is set up). Returns what happened, for the screen.
 */
export async function printReceipt(receipt: Receipt, printer: DevicePrinter | undefined, options: { openDrawer?: boolean } = {}): Promise<string> {
  if (printer && isDirect(printer)) {
    const data = printer.language === 'star' ? receiptStar(receipt, { paper: printer.paper, ...options }) : receiptEscPos(receipt, { paper: printer.paper, ...options });
    await sendRaw(printer.address!, printer.port ?? 9100, data);
    return `Printed on ${printer.name}`;
  }
  // AirPrint on iOS, Android's print services (USB and shared printers show up there once set up on the tablet).
  await Print.printAsync({ html: receiptHtml(receipt) });
  return printer ? `Sent to ${printer.name}` : 'Sent to the printer';
}

/** Prints price tags, `copies` of each, on a tag printer. */
export async function printTags(items: { tag: Tag; copies: number }[], printer: DevicePrinter): Promise<string> {
  const size = parseTagSize(printer.paper);
  const count = items.reduce((n, i) => n + i.copies, 0);
  if (isDirect(printer)) {
    const build = printer.language === 'zpl' ? tagZpl : printer.language === 'epl' ? tagEpl : printer.language === 'tspl' ? tagTspl : null;
    if (build) {
      await sendRaw(printer.address!, printer.port ?? 9100, items.map((i) => build(i.tag, size, i.copies)).join(''));
      return `${count} tag${count === 1 ? '' : 's'} printed on ${printer.name}`;
    }
  }
  await Print.printAsync({ html: tagHtml(items, size) });
  return `${count} tag${count === 1 ? '' : 's'} sent to ${printer.name}`;
}
