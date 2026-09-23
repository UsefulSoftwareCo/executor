# Examples

For an installation whose returned app slug is `live-inbox`:

```js
return await tools["live-inbox"].queries.listMessages({});
```

When the user asks to save a message:

```js
return await tools["live-inbox"].mutations.receiveMessage({
  subject: "Follow up with the support team",
});
```

Replace `live-inbox` with the returned app slug for another installation.
The query returns recent stored records. It does not fetch an external mailbox.
