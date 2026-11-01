'use client';

import {
  bubbleMapEstimate,
  type BubbleMapInput,
} from '@/lib/bubble-map-estimate';

// Captured "Bubble Maps" estimate panel. Read-only: every card is derived from
// the launch form's own values and none of them is an input. The reference only
// shows it in MEV mode, which the caller decides.
export function BubbleMapEstimate(props: BubbleMapInput) {
  const { cleanliness, cards } = bubbleMapEstimate(props);
  return (
    <div className="bubble-map-estimate">
      <div className="bubble-map-grid">
        <div className="bubble-map-card">
          <div className="bubble-map-head">
            <span className="bubble-map-label">Bubble Maps</span>
            <span
              className="bubble-map-value"
              title="Estimated bubble maps cleanliness based on buy delay timing"
            >
              {cleanliness.label}
            </span>
          </div>
          <div className="bubble-map-track-split" aria-hidden>
            <span
              className={`bubble-map-half${cleanliness.firstHalf ? ' is-filled' : ''}`}
            />
            <span
              className={`bubble-map-half${cleanliness.secondHalf ? ' is-filled' : ''}`}
            />
          </div>
          <div className="bubble-map-axis" aria-hidden>
            <span>Uncertain</span>
            <span>Likely clean</span>
          </div>
          <span className="bubble-map-sr">
            Bubble maps cleanliness: {cleanliness.label}
          </span>
        </div>

        {cards.map((card) => (
          <div className="bubble-map-card" key={card.label}>
            <div className="bubble-map-head">
              <span className="bubble-map-label">{card.label}</span>
              {/* Detection Mode is an indicator, so its value is empty. */}
              {card.value && (
                <span className="bubble-map-value">{card.value}</span>
              )}
            </div>
            <meter
              className="bubble-map-track"
              min={0}
              max={100}
              value={Math.round(card.position * 100)}
              aria-label={card.label}
              aria-valuenow={Math.round(card.position * 100)}
              aria-valuetext={card.value || card.label}
            />
            <div className="bubble-map-axis" aria-hidden>
              <span>{card.leftLabel}</span>
              <span>{card.rightLabel}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
