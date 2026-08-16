// Cek versi image terbaru di Docker Hub (registry v2 API) — bandingin
// digest image LOKAL vs yang ada di registry buat tag yang sama. Ini BUKAN
// soal versi angka (mis. postgres:17-alpine gak pernah "naik" ke
// postgres:18-alpine sendiri), tapi soal apakah image itu sudah di-REBUILD
// ulang di sumbernya (patch keamanan dst) sejak terakhir di-pull — kalau
// digest beda, ada versi baru buat tag yang sama.
//
// Cuma dukung Docker Hub (registry-1.docker.io) — image dari registry lain
// (ghcr.io, custom, dst) dilewati begitu aja, bukan dianggap error.
//
// Lewat nsenter ke jaringan HOST (bukan fetch() langsung dari sini) --
// kebukti pas testing kalau container panel sendiri (jaringan bridge
// docker-nya) gak bisa nyampe ke IP CDN registry-1.docker.io (ETIMEDOUT
// ke semua IP-nya), padahal auth.docker.io bisa dan laptop-nya sendiri
// (host) bisa nyampe dua-duanya. Sama kayak findFreePort() di autodeploy.js
// -- daripada debug jaringan bridge docker, jalanin lewat host yang
// sudah kebukti beres.
import { runP } from './stacks.js';

const NSENTER = ['-t', '1', '-m', '-u', '-n', '-i', '--'];
const REGISTRY = 'https://registry-1.docker.io';
const AUTH = 'https://auth.docker.io/token';

function parseImageRef(ref) {
  // "postgres:17-alpine" -> repo "library/postgres" tag "17-alpine"
  // "myuser/myapp:latest" -> repo "myuser/myapp" tag "latest"
  // Image custom-build lokal ("homeserver-panel:latest") juga match pola
  // ini secara sintaks -- pemanggil yang nge-skip kalau HEAD manifest-nya
  // gagal (404), bukan di sini.
  const [repoTag] = ref.split('@'); // buang @sha256:... kalau ada
  const i = repoTag.lastIndexOf(':');
  let repo = i > repoTag.lastIndexOf('/') ? repoTag.slice(0, i) : repoTag;
  const tag = i > repoTag.lastIndexOf('/') ? repoTag.slice(i + 1) : 'latest';
  if (!repo.includes('/')) repo = 'library/' + repo;
  return { repo, tag };
}

async function curlGetJson(url) {
  const { code, out } = await runP('nsenter', [...NSENTER, 'curl', '-fsS', '--max-time', '10', url]);
  if (code !== 0) throw new Error('curl gagal: ' + out.slice(0, 200));
  return JSON.parse(out);
}

async function curlHeadDigest(url, token) {
  const args = [...NSENTER, 'curl', '-fsSI', '--max-time', '10',
    '-H', `Authorization: Bearer ${token}`,
    '-H', 'Accept: application/vnd.docker.distribution.manifest.v2+json, '
      + 'application/vnd.docker.distribution.manifest.list.v2+json, '
      + 'application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json',
    url];
  const { code, out } = await runP('nsenter', args);
  if (code !== 0) return null; // 404 = bukan di Docker Hub / repo privat / tag gak ada
  const m = out.match(/^docker-content-digest:\s*(\S+)/im);
  return m ? m[1].trim() : null;
}

/* Balikin digest manifest terbaru di Docker Hub buat repo:tag itu, atau
   null kalau image-nya gak ada di Docker Hub (custom-build lokal, dsb)
   atau gagal dicek (jaringan, dst). */
export async function remoteDigest(imageRef) {
  const { repo, tag } = parseImageRef(imageRef);
  try {
    const { token } = await curlGetJson(`${AUTH}?service=registry.docker.io&scope=repository:${repo}:pull`);
    if (!token) return null;
    return await curlHeadDigest(`${REGISTRY}/v2/${repo}/manifests/${tag}`, token);
  } catch { return null; }
}

/* images: [{ RepoTags: [...], RepoDigests: [...] }] dari docker.js listImages
   (atau systemDf().Images). Balikin cuma yang beneran ada update. */
export async function checkImages(images) {
  const out = [];
  await Promise.all(images.map(async (img) => {
    const tag = img.RepoTags?.[0];
    if (!tag || tag === '<none>:<none>') return; // image tanpa nama, lewati
    const localDigest = (img.RepoDigests?.[0] || '').split('@')[1] || null;
    const remote = await remoteDigest(tag);
    if (!remote) return; // bukan di Docker Hub, gak bisa dicek
    if (localDigest && remote !== localDigest) {
      out.push({ tag, localDigest, remoteDigest: remote });
    }
  }));
  return out;
}
