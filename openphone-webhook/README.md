# Maple Holdings — OpenPhone Webhook

Serverless function that receives OpenPhone events and logs them to Firebase.

## Events handled
- call.completed (inbound + outbound)
- call.missed
- message.received (SMS in)
- message.delivered (SMS out)

## Environment variables required
- OPENPHONE_API_KEY — your OpenPhone API key

## Deploy
See setup instructions from Claude.
