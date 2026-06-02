# gproxy cloud 回传测试报告

日期：2026-06-02

## 背景

当前项目 `gproxypanle` 是给闭源 `gproxy` 下发配置的控制面板。之前为了监控节点状态，我们额外写了 `gproxy-agent.sh`，由 agent 在每台 VPS 上采集 Docker、端口、流量等状态并回传面板。

现在了解到，`gproxy` 原始配置里曾出现过类似下面的字段：

```yaml
cloud:
  nodeKey: b29a95a3
  url: https://cloud.gpxy.org
```

这说明 `gproxy` 本身可能支持主动向云端上报状态。如果能确认它的上报 API 格式，后续可以让面板直接兼容这个 cloud 回传协议，减少甚至替代当前自写 agent。

目前问题是：作者没有提供 cloud API 文档，当前生成配置里也没有自动写入 `cloud` 字段，所以需要先测试 `gproxy` 到底会向 `cloud.url` 发什么请求。

## 测试目标

目标不是马上替换 agent，而是先捕获 `gproxy` 的 cloud 回传请求，确认以下信息：

- 请求路径，例如 `/api/report`、`/node/report` 或其他路径
- 请求方法，例如 `GET`、`POST`、`PUT`
- `nodeKey` 的传递方式，是在 JSON、query、header 还是其他位置
- 请求 body 格式，是 JSON、form、纯文本还是其他格式
- 请求 header 里是否有特殊认证字段
- `gproxy` 期待的响应格式

拿到这些信息后，就可以在面板里实现兼容接口。

## 方案一：VPS 本机临时接收器

这是最快的测试方式，适合先确认 `gproxy` 是否真的会发 cloud 请求。

因为当前 Docker 命令使用的是：

```bash
--network=host
```

所以 `gproxy` 容器里的 `127.0.0.1` 就是 VPS 本机。可以在 VPS 上启动一个临时 HTTP 服务，然后把 `cloud.url` 指向它。

### 1. 在 VPS 上启动接收器

在运行 `gproxy` 的 VPS 上执行：

```bash
python3 -u - <<'PY'
from http.server import BaseHTTPRequestHandler, HTTPServer
import json, datetime

class H(BaseHTTPRequestHandler):
    def do_GET(self): self.handle_all()
    def do_POST(self): self.handle_all()
    def do_PUT(self): self.handle_all()

    def handle_all(self):
        length = int(self.headers.get("content-length", 0))
        body = self.rfile.read(length) if length else b""

        print("\n====", datetime.datetime.now().isoformat(), "====", flush=True)
        print(self.command, self.path, flush=True)
        print(dict(self.headers), flush=True)
        print(body.decode("utf-8", "replace"), flush=True)

        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"code": 0, "message": "ok", "data": None}).encode())

HTTPServer(("0.0.0.0", 18080), H).serve_forever()
PY
```

### 2. 在节点 YAML 里手动加入 cloud 配置

进入面板 `/nodes`，编辑一个测试节点，在 YAML 底部加入：

```yaml
cloud:
  nodeKey: b29a95a3
  url: http://127.0.0.1:18080
```

保存后，重新部署或重启该节点的 `gproxy`，让它重新读取配置。

### 3. 观察输出

查看刚才 Python 接收器窗口是否出现请求输出。

同时另开一个窗口查看 `gproxy` 日志：

```bash
docker logs -f gproxy
```

如果接收器有输出，保存以下内容：

- 完整请求路径
- 请求方法
- 请求 headers
- 请求 body
- `docker logs gproxy` 中相关日志

这些内容就是实现面板兼容 cloud API 的依据。

## 方案二：面板增加 HTTPS 捕获入口

如果方案一没有请求，可能是 `gproxy` 只接受 HTTPS，或者它对 `cloud.url` 有额外要求。

这时可以让面板临时增加一个捕获接口，例如：

```yaml
cloud:
  nodeKey: b29a95a3
  url: https://你的面板域名/cloud-test
```

面板端实现一个 `/cloud-test/*` 接口，把所有方法、路径、headers、body 记录到日志或文件里。

这种方式更接近原来的：

```yaml
cloud:
  nodeKey: b29a95a3
  url: https://cloud.gpxy.org
```

优点是能测试 HTTPS 场景。缺点是需要先改面板代码。

## 如果没有任何回传

如果等待 3 到 5 分钟后，接收器和日志都没有任何回传，可能原因包括：

- 当前 `gproxy` 版本没有启用 cloud 上报
- `cloud.url` 只接受 `https://`，不接受 `http://`
- `nodeKey` 必须是官方 cloud 平台生成的有效 key
- `cloud` 配置还缺少其他字段
- `gproxy` 不是定时上报，而是有连接或流量变化时才上报
- `gproxy` 对 `cloud.gpxy.org` 有硬编码校验

可以进一步让作者提供最小信息：

- `cloud.url` 是基础 URL，还是完整 API URL
- 上报路径是什么
- 上报周期是多少
- body 示例
- `nodeKey` 是否需要官方平台生成
- 是否强制 HTTPS

## 后续实现方向

如果成功捕获到回传格式，建议下一步这样做：

1. 在 `gproxypanle` 中新增 cloud 回传接口
2. 用 `nodeKey` 匹配面板里的节点
3. 把 gproxy 上报的状态写入节点状态字段
4. 在 `/nodes` 和 Dashboard 中优先展示 gproxy 原生上报状态
5. 保留 agent 作为 fallback，直到确认 cloud 回传稳定

这样迁移风险较小，不会一次性移除已有 agent 能力。

## 当前结论

目前不能直接确定能否完全去掉 agent，因为缺少 `gproxy cloud API` 文档。但从原始配置里的 `cloud.nodeKey` 和 `cloud.url` 看，`gproxy` 很可能已经具备主动上报能力。

下一步最关键的是捕获一次真实回传请求。只要拿到请求格式，面板就可以实现兼容。
