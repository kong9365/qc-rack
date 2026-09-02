// 이 앱은 항상 자기 자신의 로컬 서버(127.0.0.1) 뒤에서 동작하므로 캐시는 보조 수단이다.
// 캐시 우선으로 두면 app/data 의 기준 데이터를 교체해도 옛 데이터가 계속 나오므로
// 반드시 네트워크 우선 + 캐시 폴백으로 동작시킨다.
const CACHE = "retention-rack-offline-v8";
// GitHub Pages 는 https://계정.github.io/저장소명/ 처럼 하위 경로로 서비스되므로
// 절대경로("/index.html")를 쓰면 404 가 난다. 반드시 상대경로로 둔다.
// 기준 데이터도 미리 받아 둔다. 첫 방문 때는 서비스워커가 아직 페이지를 제어하지 않아
// 앱이 직접 받은 데이터가 캐시에 남지 않는다. 그러면 "한 번 열어두고 지하로 이동"이
// 성립하지 않으므로, install 단계에서 데이터까지 확보한다.
// (아래 fetch 처리는 네트워크 우선이라 온라인일 때는 항상 최신본으로 갱신된다)
const FILES = ["./", "./index.html", "./styles.css", "./app.js", "./manifest.webmanifest",
  "./icon-192.png", "./icon-512.png", "./vendor/jsQR.js", "./vendor/zxing.js",
  "./data/retention-samples.json", "./data/rack-master.json"];

self.addEventListener("install", (event) =>
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting())));

self.addEventListener("activate", (event) =>
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
    .then(() => self.clients.claim())));

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Cloudflare Access 등 로그인 게이트가 걸린 경우, 세션이 만료되면
        // 로그인 페이지로 리다이렉트된 응답이 돌아온다. 이걸 캐시에 넣으면
        // 오프라인일 때 앱 대신 로그인 화면이 떠서 작업이 막힌다.
        if (response.ok && !response.redirected) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || Promise.reject(new Error("offline")))));
});
