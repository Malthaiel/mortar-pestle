// Pulse Views — the pulse module's settings page (host-provided; the pulse
// module registers no settings-tab of its own). Moved verbatim from the
// retired top-level "Pulse Views" drawer tab.

import { Seg, Slider } from '../ui/index.js';
import { SectionBand, Row, StackedRow } from './section-primitives.jsx';

export default function PulseViewsPage({ settings, setSetting, accent }) {
  return (
    <>
      <SectionBand title="Shared">
        <Row label="Time format" anchor="set-timeFormat24h">
          <Seg
            value={settings.timeFormat24h}
            options={[
              { value: true,  label: '24h' },
              { value: false, label: '12h' },
            ]}
            onChange={v => setSetting('timeFormat24h', v)}
            accent={accent}
          />
        </Row>
      </SectionBand>
      <SectionBand title="Calendar">
        <StackedRow label="Hour height" anchor="set-calendarHourHeight">
          <Slider
            value={settings.calendarHourHeight}
            min={40} max={80} step={2} unit="px"
            accent={accent}
            onChange={v => setSetting('calendarHourHeight', v)}
          />
        </StackedRow>
        <Row label="Hour gutter" anchor="set-showCalendarHourGutter">
          <Seg
            value={settings.showCalendarHourGutter !== false}
            options={[
              { value: true,  label: 'Show' },
              { value: false, label: 'Hide' },
            ]}
            onChange={v => setSetting('showCalendarHourGutter', v)}
            accent={accent}
          />
        </Row>
      </SectionBand>
      <SectionBand title="Health">
        <Row label="Workout streak counter" anchor="set-showFitnessStreak">
          <Seg
            value={settings.showFitnessStreak === true}
            options={[
              { value: true,  label: 'Show' },
              { value: false, label: 'Hide' },
            ]}
            onChange={v => setSetting('showFitnessStreak', v)}
            accent={accent}
          />
        </Row>
      </SectionBand>
    </>
  );
}
