// Flashing the Pod from the browser, over WebUSB.
//
// The Daisy bootloader speaks DfuSe (ST's DFU dialect): you set an address
// with a command, then write blocks to it. Everything here is that, plus
// enough status polling to know when an erase finished.
//
// Used by editor.html's Update firmware panel. The page asks the running
// firmware to reboot into DFU (NRPN 6) first, so nobody has to hold BOOT
// and tap RESET.
//
// Only Chrome and Edge have WebUSB. On Windows the STM32 DFU device needs a
// WinUSB driver (Zadig) before the browser can claim it -- the page says so
// when it can't.

const DFU_DETACH = 0x00, DFU_DNLOAD = 0x01, DFU_GETSTATUS = 0x03,
      DFU_CLRSTATUS = 0x04, DFU_ABORT = 0x06;
const STATE_DFU_IDLE = 2, STATE_DFU_DOWNLOAD_BUSY = 4, STATE_DFU_DOWNLOAD_IDLE = 5,
      STATE_DFU_ERROR = 10;

const DAISY_APP_ADDRESS      = 0x90040000; // the app, in QSPI
const DAISY_WAVEDATA_ADDRESS = 0x900C0000; // the compiled-in samples

class DfuDevice {
  // this.interfaceNumber, NOT this.iface -- the constructor below names it
  // the former. Reading the wrong field returned '' every time, so
  // layoutCovers() always answered "cannot judge" and the refusal that is
  // supposed to stop a write to the wrong bootloader never fired.
  layout() { return layoutOf(this.device, this.interfaceNumber); }

  constructor(device, iface) {
    this.device = device;
    this.interfaceNumber = iface;
    this.transferSize = 1024; // the bootloader's own block size
  }

  async open() {
    await this.device.open();
    if (this.device.configuration === null) await this.device.selectConfiguration(1);
    await this.device.claimInterface(this.interfaceNumber);
    await this.toIdle();
  }

  // A DFU device remembers how the last session ended. Left in dfuERROR by a
  // failed attempt -- or part-way through a download -- it rejects the next
  // command block, and the STM32 reports that as status 11, errVENDOR: "it
  // went wrong and I do not know why". That is what an erase failed with
  // after the earlier broken attempt: nothing was wrong with the erase, the
  // device simply had not been told the previous conversation was over.
  //
  // dfu-util does this on every connect, which is why it always worked from
  // the command line while the browser did not.
  async toIdle() {
    for (let i = 0; i < 4; i++) {
      let s;
      try { s = await this.getStatus(); } catch (e) { return; }
      if (s.state === STATE_DFU_IDLE) return;
      if (s.state === STATE_DFU_ERROR) { await this.clearStatus(); continue; }
      // Anything else (a download left open, a manifest pending) is ended
      // with ABORT rather than waited out.
      try { await this.controlOut(DFU_ABORT, 0, undefined); } catch (e) { /* keep trying */ }
    }
  }

  async close() {
    try { await this.device.releaseInterface(this.interfaceNumber); } catch (e) {}
    try { await this.device.close(); } catch (e) {}
  }

  async controlOut(request, value, data) {
    const r = await this.device.controlTransferOut(
      { requestType: 'class', recipient: 'interface', request, value, index: this.interfaceNumber },
      data);
    if (r.status !== 'ok') throw new Error(`control transfer failed: ${r.status}`);
    return r;
  }

  async controlIn(request, length, value = 0) {
    const r = await this.device.controlTransferIn(
      { requestType: 'class', recipient: 'interface', request, value, index: this.interfaceNumber },
      length);
    if (r.status !== 'ok') throw new Error(`control transfer failed: ${r.status}`);
    return r.data;
  }

  async getStatus() {
    const d = await this.controlIn(DFU_GETSTATUS, 6);
    return { status: d.getUint8(0),
             pollTimeout: d.getUint8(1) | (d.getUint8(2) << 8) | (d.getUint8(3) << 16),
             state: d.getUint8(4) };
  }

  async clearStatus() {
    await this.controlOut(DFU_CLRSTATUS, 0, undefined);
  }

  // Wait for whatever was asked for (an erase, a write) to finish, honouring
  // the device's own poll timeout. An erase of a 64K sector takes a while.
  async poll(what) {
    for (;;) {
      const s = await this.getStatus();
      if (s.state === STATE_DFU_ERROR) {
        await this.clearStatus();
        throw new Error(`${what}: the device reported error status ${s.status}`);
      }
      if (s.state !== STATE_DFU_DOWNLOAD_BUSY) return s;
      await new Promise((r) => setTimeout(r, Math.max(s.pollTimeout, 5)));
    }
  }

  // DfuSe: a command block (wValue 0) that sets where the following writes go.
  async setAddress(addr) {
    const cmd = new Uint8Array([0x21, addr & 0xff, (addr >> 8) & 0xff, (addr >> 16) & 0xff, (addr >> 24) & 0xff]);
    await this.controlOut(DFU_DNLOAD, 0, cmd);
    await this.poll('setting the address');
  }

  async erasePage(addr) {
    const cmd = new Uint8Array([0x41, addr & 0xff, (addr >> 8) & 0xff, (addr >> 16) & 0xff, (addr >> 24) & 0xff]);
    await this.controlOut(DFU_DNLOAD, 0, cmd);
    await this.poll('erasing 0x' + addr.toString(16));
  }

  async leave() {
    // A zero-length download, then a status read, makes the bootloader run
    // what was just flashed.
    await this.controlOut(DFU_DNLOAD, 0, new Uint8Array(0));
    try { await this.getStatus(); } catch (e) { /* it may reset mid-answer */ }
  }

  // Write `data` at `addr`. `onProgress(done, total)` is called as it goes.
  async write(addr, data, onProgress) {
    // Erase first -- the bootloader's flash needs it, and dfu-util does the
    // same. 64K sectors from 0x90040000 up (see its memory map).
    const sector = 64 * 1024;
    const first = Math.floor((addr - 0x90000000) / sector) * sector + 0x90000000;
    for (let a = first; a < addr + data.byteLength; a += sector) {
      await this.erasePage(a);
      if (onProgress) onProgress(0, data.byteLength, 'erasing');
    }
    await this.setAddress(addr);
    let done = 0, block = 2; // DfuSe data blocks start at 2
    while (done < data.byteLength) {
      const chunk = data.slice(done, Math.min(done + this.transferSize, data.byteLength));
      await this.controlOut(DFU_DNLOAD, block++, chunk);
      await this.poll('writing');
      done += chunk.byteLength;
      if (onProgress) onProgress(done, data.byteLength, 'writing');
    }
  }
}

// Ask the person to pick the Daisy (the browser requires a user gesture and
// its own chooser -- a page can't scan for devices by itself).
async function requestDaisy() {
  if (!navigator.usb) throw new Error('This browser has no WebUSB. Use Chrome or Edge.');
  const device = await navigator.usb.requestDevice({ filters: [{ vendorId: 0x0483, productId: 0xdf11 }] });
  // The DFU interface: class 0xFE, subclass 1.
  let iface = null;
  for (const cfg of device.configurations)
    for (const i of cfg.interfaces)
      for (const alt of i.alternates)
        if (alt.interfaceClass === 0xfe && alt.interfaceSubclass === 0x01 && iface === null)
          iface = i.interfaceNumber;
  if (iface === null) throw new Error('that device has no DFU interface');
  return new DfuDevice(device, iface);
}

// The DFU memory layout, from the interface's own name string, e.g.
//   "@Flash /0x90000000/64*4Kg/0x90040000/60*64Kg/0x90400000/60*64Kg"  (QSPI)
//   "@Internal Flash /0x08000000/16*128Kg"                             (ROM)
// This matters more than it looks: the STM32's ROM bootloader exposes ONLY
// internal flash, while this app lives in QSPI at 0x90040000. Writing that
// address over the ROM interface does not fail loudly -- it reports success
// and the board will not boot afterwards. So the layout is checked and the
// write refused, rather than trusted.
function layoutOf(device, ifaceNum) {
  for (const cfg of device.configurations)
    for (const i of cfg.interfaces)
      for (const alt of i.alternates)
        if (alt.interfaceClass === 0xfe && alt.interfaceSubclass === 0x01
            && i.interfaceNumber === ifaceNum)
          return alt.interfaceName || '';
  return '';
}

// Does this interface cover `addr`? Parses the segment list above.
function layoutCovers(name, addr) {
  if (!name) return null;                    // nothing to judge by
  const segs = [...name.matchAll(/\/(0x[0-9a-fA-F]+)\/(\d+)\*(\d+)([KMB])/g)];
  if (!segs.length) return null;
  for (const [, base, count, size, unit] of segs) {
    const mult = unit === 'M' ? 1048576 : (unit === 'K' ? 1024 : 1);
    const start = parseInt(base, 16);
    const end = start + Number(count) * Number(size) * mult;
    if (addr >= start && addr < end) return true;
  }
  return false;
}

// Is a Daisy already sitting in DFU? (Only sees devices already permitted.)
async function findPermittedDaisy() {
  if (!navigator.usb) return null;
  const list = await navigator.usb.getDevices();
  const d = list.find((x) => x.vendorId === 0x0483 && x.productId === 0xdf11);
  return d ? new DfuDevice(d, 0) : null;
}

// Plain script rather than a module, so the published single-file build can
// inline it beside everything else.
window.WebDfu = { DfuDevice, requestDaisy, findPermittedDaisy,
                  layoutOf, layoutCovers,
                  DAISY_APP_ADDRESS, DAISY_WAVEDATA_ADDRESS };
