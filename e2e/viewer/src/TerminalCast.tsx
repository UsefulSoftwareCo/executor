// asciinema-player over a run's terminal.cast — the terminal twin of the
// browser surface's session video. Idle stretches (token-expiry waits) are
// compressed so playback stays watchable.
import { useEffect, useRef } from "react";
import * as AsciinemaPlayer from "asciinema-player";
import "asciinema-player/dist/bundle/asciinema-player.css";

const TerminalCast = ({ url }: { url: string }) => {
  const mount = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!mount.current) return;
    const player = AsciinemaPlayer.create(url, mount.current, {
      autoPlay: true,
      idleTimeLimit: 2,
      fit: "width",
      terminalFontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    });
    return () => player.dispose();
  }, [url]);
  return <div ref={mount} className="cast-player" />;
};

export default TerminalCast;
