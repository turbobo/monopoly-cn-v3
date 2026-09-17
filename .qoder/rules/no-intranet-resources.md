---
trigger: always_on
---

# MyApp 目录级强制规则：禁止任何内网 / 私有资源

> 本规则适用于 `MyApp/` 下的**全部子项目**（应用、工具、模板、试验性、备份项目），
> 与工作区 `AGENTS.md` 同级生效，优先级不低于它。

## 一、绝对禁止

任何提交到 `MyApp/` 下的**代码、配置、脚本、lockfile、文档、注释**，
都不得出现下列内容：

### 1. 内网域名与地址

禁止出现：`alibaba-inc.com`、`alibaba.net`、`antfin.com`、`aliwork.com`、
`registry.anpm.*`、`npm.alibaba-inc.*`、任何办公网/VPN 内才可达的域名或 IP。

### 2. 内网工具与私有配置

- 禁止引用公司内网 CLI、私有 SDK、内部脚手架、内部制品库
- 禁止在 `.npmrc` / `.yarnrc` / `.pnpmrc` / `settings.xml` / `pip.conf` / `.condarc`
  中配置内网源
- 禁止使用内网 CI/CD、发布平台、代码托管地址

### 3. lockfile 污染（重点）

- `package-lock.json` / `yarn.lock` / `pnpm-lock.yaml` 的 `resolved` 字段
  **必须全部为公网地址**
- lockfile 必须能在无公司网络的公有云 CI（EdgeOne / Vercel / GitHub Actions）
  中通过 `npm ci` 完整安装
- 必须包含 Linux 平台二进制（`@esbuild/linux-*`、`@rollup/rollup-linux-*`），
  否则云端构建会失败

## 二、允许使用的公网源

| 生态 | 允许的源 |
| --- | --- |
| npm | `https://registry.npmjs.org`、`https://registry.npmmirror.com` |
| Maven | `https://repo.maven.apache.org`、`https://maven.aliyun.com/repository/public` |
| Python | `https://pypi.org`、`https://pypi.tuna.tsinghua.edu.cn/simple` |
| Go | `https://proxy.golang.org`、`https://goproxy.cn` |
| 代码托管 | GitHub、Gitee |

**判定标准**：放到没有公司网络的环境（家庭网络、公有云 CI）能否直接访问。
不能访问即属内网，禁止使用。

**注意区分**：`registry.anpm.alibaba-inc.com` 是内网（禁止）；
`registry.npmmirror.com`、`maven.aliyun.com` 是公网镜像（允许）。

## 三、执行要求

1. **选型阶段**：引入依赖、脚手架、CI 模板前，先确认来源为公网。
2. **新增子项目**：`package.json` 旁必须存在指向公网源的 `.npmrc`。
3. **安装依赖后**：立即检查 lockfile 是否被写入内网地址。
4. **提交前**：必跑下面的自检命令，命中即视为阻塞项，必须当次修复。
5. **文档同步**：修复内网引用后，同步更新该子项目的 `技术方案文档.md` 或 `AGENTS.md`。

## 四、提交前自检命令

在 `MyApp/` 根目录执行：

```bash
grep -rnE 'alibaba-inc\.com|alibaba\.net|antfin\.com|aliwork\.com|registry\.anpm' . \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.next \
  --exclude-dir=dist --exclude-dir=out --exclude-dir=build
```

- 预期输出：**零命中**
- 唯一允许的例外：本规则文件自身与 `AGENTS.md` 中的**反例说明**
- lockfile 额外校验：

```bash
grep -o '"resolved": "https://[^/]*' <lockfile> | sort | uniq -c
```

输出中若出现内网域名，必须立即重新生成 lockfile。
