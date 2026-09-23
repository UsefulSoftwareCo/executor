import { Tweet } from "react-tweet";

export function TweetEmbed({ id }: { id: string }) {
  return (
    <div className="flex justify-center" data-theme="light">
      <Tweet id={id} />
    </div>
  );
}
