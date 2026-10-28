/** Independent authenticated HTTPS readback, never an application import or a result fixture. */
import { readFile } from "node:fs/promises";
import { request } from "node:https";
export interface PrivateReadback {
  url: string;
  certificateFile: string;
  privateKeyFile: string;
  certificateAuthorityFile: string;
}
export const actualReadback = async (config: PrivateReadback): Promise<unknown> => {
  const url = new URL(config.url);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("Authenticated HTTPS readback required");
  const [cert, key, ca] = await Promise.all(
    [config.certificateFile, config.privateKeyFile, config.certificateAuthorityFile].map((file) =>
      readFile(file),
    ),
  );
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { method: "GET", cert, key, ca, rejectUnauthorized: true, timeout: 10000 },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error("Readback refused"));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 262144) response.destroy(new Error("Readback bound exceeded"));
          else chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("Readback deadline")));
    req.on("error", reject);
    req.end();
  });
};
