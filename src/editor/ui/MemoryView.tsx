import { useState, type ReactElement } from 'react';
import { formatRomContents, formatValue, logic, parseValue, type LogicValue, type Radix } from '../../engine/index.ts';
import { intOf, setComponentProps, strOf, type ComponentInstance } from '../../model/index.ts';
import { useEditor, useServices, useSimStatus } from '../context.ts';

const RADIX_LABEL: Record<Radix, string> = { hex: 'Hex', bin: 'Binary', dec: 'Decimal', sdec: 'Signed' };

function cell(v: LogicValue, radix: Radix): string {
  const s = formatValue(v, radix);
  if (radix === 'hex') return s.padStart(Math.ceil(v.width / 4), '0');
  return s;
}

/**
 * Contents of a RAM or ROM: a paged grid of words with the last read and
 * written addresses highlighted. Click a word to change it. RAM edits change
 * the running simulation; ROM edits change the saved contents (undoable).
 */
export function MemoryView({ comp }: { comp: ComponentInstance }): ReactElement | null {
  const { host, store } = useServices();
  const path = useEditor((s) => s.path);
  useEditor((s) => s.revision);
  useSimStatus();
  const [radix, setRadix] = useState<Radix>('hex');
  const [page, setPage] = useState(0);
  const [editing, setEditing] = useState<number | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [goto, setGoto] = useState('');
  const [bulk, setBulk] = useState<string | null>(null);

  const mem = host.memory(path, comp.id);
  if (!mem) return null;
  const isRom = comp.type === 'rom';
  const width = mem.width;
  const cols = width <= 8 ? 8 : width <= 16 ? 4 : 2;
  const rowsPerPage = 16;
  const perPage = cols * rowsPerPage;
  const pages = Math.max(1, Math.ceil(mem.words / perPage));
  const current = Math.min(page, pages - 1);
  const start = current * perPage;
  const addrDigits = Math.max(1, Math.ceil(Math.log2(mem.words) / 4));
  const read = (addr: number): LogicValue => {
    const w = mem.read(addr);
    return logic(width, w.a, w.b);
  };

  const commit = (addr: number) => {
    const v = parseValue(text, width);
    if (!v) {
      setError(`Enter a ${width}-bit value (decimal, 0x hex or 0b binary).`);
      return;
    }
    setError(null);
    setEditing(null);
    if (isRom) {
      const words = Int32Array.from({ length: mem.words }, (_, i) => (i === addr ? v.a : mem.read(i).a));
      const contents = formatRomContents(words, width);
      store.editViewed((c, ctx) => setComponentProps(c, comp.id, { contents }, ctx));
    } else {
      host.writeMemory(path, comp.id, addr, v);
    }
  };

  const jump = () => {
    const v = parseValue(goto.startsWith('0x') || goto.startsWith('0b') ? goto : `0x${goto}`, Math.max(1, intOf(comp.props, 'addrWidth')));
    if (!v || v.b !== 0) {
      setError('Enter an address in hexadecimal.');
      return;
    }
    setError(null);
    setPage(Math.floor((v.a >>> 0) / perPage));
  };

  const rows: number[] = [];
  for (let a = start; a < Math.min(start + perPage, mem.words); a += cols) rows.push(a);

  return (
    <div className="memory-view">
      <h3>
        {isRom ? 'ROM' : 'RAM'} contents · {mem.words} × {width} bit
      </h3>
      <div className="memory-toolbar">
        <select value={radix} onChange={(e) => setRadix(e.target.value as Radix)} aria-label="Number format">
          {(Object.keys(RADIX_LABEL) as Radix[]).map((r) => (
            <option key={r} value={r}>
              {RADIX_LABEL[r]}
            </option>
          ))}
        </select>
        <input className="goto" placeholder="Go to 0x…" value={goto} onChange={(e) => setGoto(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && jump()} aria-label="Go to address" />
        <button onClick={() => setPage(Math.max(0, current - 1))} disabled={current === 0} aria-label="Previous page">
          ‹
        </button>
        <span className="muted small">
          {current + 1}/{pages}
        </span>
        <button onClick={() => setPage(Math.min(pages - 1, current + 1))} disabled={current >= pages - 1} aria-label="Next page">
          ›
        </button>
      </div>
      <table className="memory-grid">
        <tbody>
          {rows.map((rowAddr) => (
            <tr key={rowAddr}>
              <th scope="row">{rowAddr.toString(16).padStart(addrDigits, '0')}</th>
              {Array.from({ length: cols }, (_, j) => rowAddr + j)
                .filter((addr) => addr < mem.words)
                .map((addr) => {
                  const cls = [addr === mem.lastWrite ? 'written' : '', addr === mem.lastRead ? 'read' : ''].join(' ').trim();
                  return (
                    <td key={addr} className={cls} title={`Address 0x${addr.toString(16)} (${addr})${addr === mem.lastRead ? ' · last read' : ''}${addr === mem.lastWrite ? ' · last written' : ''}`}>
                      {editing === addr ? (
                        <input
                          autoFocus
                          className="mem-input"
                          value={text}
                          aria-label={`Value at address ${addr}`}
                          onChange={(e) => setText(e.target.value)}
                          onBlur={() => setEditing(null)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commit(addr);
                            if (e.key === 'Escape') setEditing(null);
                          }}
                        />
                      ) : (
                        <button
                          className="mem-cell"
                          aria-label={`Edit address ${addr}`}
                          onClick={() => {
                            setEditing(addr);
                            setText(radix === 'hex' ? `0x${cell(read(addr), 'hex')}` : formatValue(read(addr), 'dec'));
                          }}
                        >
                          {cell(read(addr), radix)}
                        </button>
                      )}
                    </td>
                  );
                })}
            </tr>
          ))}
        </tbody>
      </table>
      {error && <p className="error-text">{error}</p>}
      <p className="muted small">
        <span className="legend read">■</span> last read · <span className="legend written">■</span> last written.{' '}
        {isRom ? 'Contents are saved with the project.' : 'Contents are simulation state: they reset with Reset and are not saved.'}
      </p>
      {isRom &&
        (bulk === null ? (
          <button onClick={() => setBulk(strOf(comp.props, 'contents'))}>Edit all as text…</button>
        ) : (
          <div className="field">
            <label htmlFor={`rom-text-${comp.id}`}>Hex words from address 0, separated by spaces or new lines</label>
            <textarea id={`rom-text-${comp.id}`} rows={6} className="mono" value={bulk} onChange={(e) => setBulk(e.target.value)} />
            <div className="button-row">
              <button
                onClick={() => {
                  const def = bulk;
                  store.editViewed((c, ctx) => setComponentProps(c, comp.id, { contents: def }, ctx));
                  const after = store.viewedCircuit.components.find((c) => c.id === comp.id);
                  if (after && strOf(after.props, 'contents') === def) setBulk(null);
                }}
              >
                Apply
              </button>
              <button onClick={() => setBulk(null)}>Cancel</button>
            </div>
          </div>
        ))}
    </div>
  );
}
