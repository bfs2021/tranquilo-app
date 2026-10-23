# Image resize Lambda

`template.yaml` is a CloudFormation stack for the image cache's miss path:
a Lambda (`lambda/img-resize/`) that fetches one museum image, resizes it,
writes it to the image bucket and redirects to the CDN copy. It sits behind
its own CloudFront distribution and cannot be called any other way.

Deploying the stack changes nothing for visitors. Traffic reaches the
function only after the image proxy is pointed at the stack's
`ResizeBaseUrl` output.

## What the stack creates

| Resource | Purpose |
|---|---|
| IAM role | Lets the function write `img-cache/*` in the image bucket and write its logs. No access keys. |
| Lambda function (arm64) | Runs `lambda/img-resize/handler.ts`. |
| Function URL (`AWS_IAM`) | The function's HTTPS endpoint. Only signed requests are accepted. |
| CloudFront distribution + origin access control | Signs requests to the function URL and caches each redirect. |
| Log group | Function logs, kept 30 days. |

## Build the zip

```
bun run build:lambda
```

This writes `build/lambda-img-resize.zip` with sharp's linux-arm64 binary.

## First deploy (AWS console)

1. **Code bucket.** In S3, create a private bucket for deployment zips
   (default settings keep it private). It MUST NOT be the image bucket,
   which is public through the CDN. Upload the zip, ideally under a
   versioned key such as `img-resize/2026-10-23.zip`.
2. **Region.** Switch the console to the image bucket's region.
3. **Create the stack.** CloudFormation → Create stack → With new
   resources → Upload a template file → `lambda/img-resize/template.yaml`.
4. **Parameters.**
   - `CodeBucket`, `CodeKey`: from step 1.
   - `ImageBucket`, `ImageBucketRegion`, `CdnBaseUrl`: copy the app's
     `S3_BUCKET`, `S3_REGION` and `IMG_CDN_BASE_URL` values.
   - `DatabaseUrl`: the app's `DATABASE_URL`. A Postgres role limited
     to the image cache tables and `SELECT` on `items` SHOULD be used
     instead of the owner role.
   - `SentryDsn`: optional.
   - Leave the rest at their defaults.
5. **Capabilities.** Tick "I acknowledge that AWS CloudFormation might
   create IAM resources", then create. The CloudFront distribution takes
   a few minutes.
6. **Check.** Open the `ResizeBaseUrl` output with
   `?source=met&id=<a native id>&tier=display`. A cached image redirects
   to the CDN. A request without parameters returns 400. A request to the
   function URL itself returns 403.

## Updating the code

Build, upload the new zip under a new key, then CloudFormation → the
stack → Update → Use current template, and change `CodeKey`. A rollback
is the same update with the previous key.

## Removing it

Delete the stack. Images already written stay in the bucket; the image
proxy MUST be pointed away from `ResizeBaseUrl` first.
