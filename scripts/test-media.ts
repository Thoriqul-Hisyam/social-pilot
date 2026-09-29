/** Self-check for R2 signing and image sniffing. No network, no uploads. */
import { signV4, sniffImage } from '../lib/media'

let n = 0
const check = (name: string, cond: boolean) => {
  if (!cond) { console.error(`FAIL: ${name}`); process.exit(1) }
  n++
}

// Worked examples from the AWS SigV4 docs for S3 (sig-v4-header-based-auth).
const creds = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secret: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1' }
const emptyHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

const get = signV4({
  ...creds, method: 'GET', path: '/test.txt', payloadHash: emptyHash,
  headers: { host: 'examplebucket.s3.amazonaws.com', range: 'bytes=0-9', 'x-amz-content-sha256': emptyHash, 'x-amz-date': '20130524T000000Z' },
})
check('GET example signature', get.endsWith('Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41'))
check('GET example scope', get.includes('Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request'))
check('GET example signed headers', get.includes('SignedHeaders=host;range;x-amz-content-sha256;x-amz-date'))

const putHash = '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072' // "Welcome to Amazon S3."
const put = signV4({
  ...creds, method: 'PUT', path: '/test%24file.text', payloadHash: putHash,
  headers: {
    Host: 'examplebucket.s3.amazonaws.com', Date: 'Fri, 24 May 2013 00:00:00 GMT',
    'x-amz-date': '20130524T000000Z', 'x-amz-storage-class': 'REDUCED_REDUNDANCY', 'x-amz-content-sha256': putHash,
  },
})
check('PUT example signature', put.endsWith('Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd'))

// Sniffing goes by bytes, not by what the CDN claims.
const bytes = (...b: (number | string)[]) => new Uint8Array(b.flatMap(x => typeof x === 'string' ? [...x].map(c => c.charCodeAt(0)) : [x]))
check('jpeg', 'ext' in sniffImage(bytes(0xff, 0xd8, 0xff, 0xe0)) && (sniffImage(bytes(0xff, 0xd8, 0xff, 0xe0)) as { ext: string }).ext === 'jpg')
check('png', (sniffImage(bytes(0x89, 'PNG', 0x0d, 0x0a)) as { ext: string }).ext === 'png')
check('webp rejected', (sniffImage(bytes('RIFF', 0, 0, 0, 0, 'WEBP')) as { unsupported: string }).unsupported === 'webp')
check('avif rejected', (sniffImage(bytes(0, 0, 0, 0x1c, 'ftypavif')) as { unsupported: string }).unsupported === 'avif')
check('html rejected', (sniffImage(bytes('<!DOCTYPE html>')) as { unsupported: string }).unsupported === 'not an image')

console.log(`test-media: ${n} checks passed`)
