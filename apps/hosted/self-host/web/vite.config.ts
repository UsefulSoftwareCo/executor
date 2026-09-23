import { dashboardViteConfig } from "@executor-js/hosted-web/vite";

export default dashboardViteConfig({
  apiUrl: process.env.HOSTED_API_URL ?? "http://127.0.0.1:4400",
  port: 4410,
});
