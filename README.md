# Haven API

[中文](README.md) · [English](README.en.md)

面向结构化模型编辑的后端服务：管理草稿、校验、版本和发布，并为候选修改提供独立的审阅过程。基于 NestJS 与 SQLite，适合作为模型编辑器或自动化客户端的数据与校验接口。

## 功能

- 模型与草稿：分页查询模型，读取、创建和更新草稿。
- 契约校验：使用 Haven Kit 的文档与编辑契约，返回结构化校验结果。
- 版本发布：读取版本与已发布文档，执行发布及回滚。
- 并发与幂等：修订号检查与发布幂等键。
- 候选修改：创建候选、提交命令、查看操作、校验或放弃。
- 接口描述：OpenAPI、能力查询、文档 Schema 与编辑 Schema。

## 快速开始

Node.js `>=26.13.0 <27`、pnpm `12.18.0`；需要与依赖版本一致的 Haven Kit 包。

```sh
# Build and publish matching Haven Kit packages to your registry first.
corepack enable
cp .env.example .env
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

## 配置

| 配置项 | 说明 |
| --- | --- |
| `HOST / PORT` | 默认 `127.0.0.1:3000`。 |
| `HAVEN_DATABASE` | SQLite 数据文件，默认 `./data/haven.db`。 |
| `HAVEN_API_TOKEN` | 生产环境或非回环监听地址需要的访问凭据。 |
| `@haven registry` | 通过项目 npm 配置连接自己的包仓库。 |

## 使用

启动后查看 `GET /api/v1/health` 与 `/api/v1/openapi.json`。模型接口位于 `/api/v1/models`，候选操作位于 `/api/v1/candidates`。客户端保存或发布时应携带接口要求的修订号与幂等字段。

## 项目结构

- `src/models/` — 模型、草稿与发布
- `src/candidates/` — 候选编辑
- `src/storage/` — SQLite 持久化

## 许可

[PolyForm Noncommercial 1.0.0](LICENSE)。原创部分与第三方组件的适用范围见 [LICENSE_SCOPE.md](LICENSE_SCOPE.md)；各第三方版权和许可见相应声明文件。
