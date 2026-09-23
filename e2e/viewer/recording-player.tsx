import {
  MediaController,
  MediaControlBar,
  MediaErrorDialog,
  MediaFullscreenButton,
  MediaPlayButton,
  MediaPlaybackRateButton,
  MediaSeekBackwardButton,
  MediaSeekForwardButton,
  MediaTimeDisplay,
  MediaTimeRange,
} from "media-chrome/react";

/** Accessible recording controls stay visible below the footage and follow the viewer theme. */
export function RecordingPlayer({
  src,
  poster,
  filmstrip,
}: {
  src: string;
  poster: string | undefined;
  filmstrip: string | undefined;
}) {
  return (
    <MediaController noAutohide aria-label="Test recording player">
      <video slot="media" playsInline preload="metadata" poster={poster} src={src} />
      <MediaTimeRange
        aria-label="Seek recording"
        data-filmstrip={filmstrip ? "" : undefined}
        style={filmstrip ? { backgroundImage: `url(${JSON.stringify(filmstrip)})` } : undefined}
      />
      <MediaControlBar>
        <MediaPlayButton />
        <MediaSeekBackwardButton seekOffset={5} />
        <MediaSeekForwardButton seekOffset={5} />
        <MediaTimeDisplay showDuration noToggle />
        <MediaPlaybackRateButton rates={[0.25, 0.5, 0.75, 1, 1.5, 2]} />
        <MediaFullscreenButton />
      </MediaControlBar>
      <MediaErrorDialog slot="dialog" />
    </MediaController>
  );
}
