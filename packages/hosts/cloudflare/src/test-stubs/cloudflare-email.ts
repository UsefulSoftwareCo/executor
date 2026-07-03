export class EmailMessage {
  constructor(
    readonly from: string,
    readonly to: string,
    readonly raw: ReadableStream | string,
  ) {}
}
