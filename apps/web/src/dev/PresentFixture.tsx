import { useEffect, useMemo, useState } from 'react';
import { joinLink } from '../state/charts.ts';
import { presenterView } from '../state/presenterView.ts';
import { PresentScreen } from '../screens/present/PresentScreen.tsx';
import { barStateFor } from '../screens/present/controls.ts';
import { qrDataUrl } from '../screens/present/qr.ts';
import { TEXT_SCALES } from '../ui/Stage.tsx';
import type { TextScale } from '../ui/Stage.tsx';
import { HOST_PIN } from './fixtures/hostSnapshots.ts';
import { JOIN_URL, NOW } from './fixtures/common.ts';
import { PRESENT_FIXTURES } from './fixtures/present.ts';
import type { PresentFixture, PresentFixtureId } from './fixtures/present.ts';

const noop = () => undefined;

/**
 * A presenter fixture, interactive so a developer can try the text size, the theme, the help
 * overlay and the wall pager. Nothing here persists or touches the network.
 */
export function PresentFixtureScreen({ id }: { id: PresentFixtureId }) {
  const fixture: PresentFixture = PRESENT_FIXTURES[id];
  const [scale, setScale] = useState<TextScale>(1);
  const [dark, setDark] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [help, setHelp] = useState<boolean>(fixture.helpOpen ?? false);
  const [wallPage, setWallPage] = useState(0);
  const game = barStateFor(fixture.state.snapshot);
  const [locked, setLocked] = useState(game.locked);

  const view = presenterView(fixture.state, NOW);
  const link = joinLink(JOIN_URL, HOST_PIN);
  const qrSrc = useMemo(() => qrDataUrl(link), [link]);

  // The gallery's own `?theme=` wins until the toggle is used.
  useEffect(() => {
    if (!dark) return;
    const root = document.documentElement;
    const before = root.dataset.theme;
    root.dataset.theme = 'dark';
    return () => {
      if (before === undefined) delete root.dataset.theme;
      else root.dataset.theme = before;
    };
  }, [dark]);

  return (
    <PresentScreen
      view={view}
      joinUrl={JOIN_URL}
      qrSrc={qrSrc}
      qrAlt={`QR code that opens ${link}`}
      imageUrl={fixture.imageUrl ?? null}
      textScale={scale}
      connection="open"
      animate={false}
      wallPage={wallPage}
      onWallPage={setWallPage}
      helpOpen={help}
      onHelpClose={() => setHelp(false)}
      onReload={noop}
      onSignOut={noop}
      bar={{
        ...game,
        locked,
        textScale: scale,
        dark,
        fullscreen: false,
        hidden,
        onNext: noop,
        onClose: noop,
        onLock: () => setLocked((v) => !v),
        onTextSize: () =>
          setScale((s) => TEXT_SCALES[(TEXT_SCALES.indexOf(s) + 1) % TEXT_SCALES.length] ?? 1),
        onTheme: () => setDark((v) => !v),
        onFullscreen: noop,
        onHelp: () => setHelp(true),
        onToggleHidden: () => setHidden((v) => !v),
      }}
    />
  );
}
