import { Minus, Plus } from 'lucide-react';
import './EffortSlider.css';

// Snapping slider over a model's effort stops. The −/+ steppers and tappable
// stop dots matter on iOS, where a range input only moves by dragging its thumb.
export default function EffortSlider({ stops, value, onChange }) {
  if (stops.length <= 1) {
    return <p className="es-unsupported">This model doesn't support effort levels</p>;
  }

  const index = Math.max(0, stops.findIndex(stop => stop.value === value));
  const last = stops.length - 1;
  const current = stops[index];
  const select = (next) => {
    if (next >= 0 && next <= last && next !== index) onChange(stops[next].value);
  };

  return (
    <div className="es" style={{ '--es-fill': index / last }}>
      <div className="es-row">
        <button
          type="button"
          className="es-step"
          aria-label="Lower effort"
          disabled={index === 0}
          onClick={() => select(index - 1)}
        >
          <Minus size={16} />
        </button>
        <div className="es-track">
          <input
            type="range"
            className="es-range"
            min={0}
            max={last}
            step={1}
            value={index}
            aria-label="Effort"
            aria-valuetext={current.label}
            onChange={e => select(Number(e.target.value))}
          />
          <div className="es-ticks" aria-hidden="true">
            {stops.map((stop, i) => (
              <button
                key={stop.value}
                type="button"
                tabIndex={-1}
                className={`es-tick ${i <= index ? 'on' : ''}`}
                style={{ left: `${(i / last) * 100}%` }}
                onClick={() => select(i)}
              />
            ))}
          </div>
        </div>
        <button
          type="button"
          className="es-step"
          aria-label="Raise effort"
          disabled={index === last}
          onClick={() => select(index + 1)}
        >
          <Plus size={16} />
        </button>
      </div>
      <p className="es-value">
        <span className="es-value-label">{current.label}</span>
        {current.description && <> — {current.description}</>}
      </p>
    </div>
  );
}
