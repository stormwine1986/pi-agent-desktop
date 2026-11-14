# 实体附件面板（ATTM-PANEL，`SSR-000126`）

实体面板的「附件」页只做三件事：**按分类列出当前生效的附件**、**下载**、**按分类上传**。
历史视图（「当前版本 / 修订 / 时点」）已在 `SSR-000126` rev 4 撤掉：面板始终读当前修订。

## 谁说了算

| 语义 | 归属 | 工作台只做什么 |
| --- | --- | --- |
| 分类、`multiple`、`contentTypes`、`maxSizeMb`、写权限（状态 × 角色） | 领域模型 → 基座 `get_metadata` | 读 `attachments` 块，算出「有没有入口 / 入口能不能点」 |
| 读权限过滤 | 基座（列表与下载同一个 predicate） | **不再过滤一次**——第二套 predicate 就是绕过口（`SSR-000101` ③） |
| 存内容、绑定、去重、限额 | 基座两步式 REST 通道 | 代理转发 + 预检 + 说明失败在哪一步 |

## 文件

- `lib/entity-attachments.ts`：纯函数。`attachmentCategoriesView`（每个分类 + 写判定 + `uploadable`）、
  `attachmentUploadEntries`（入口顺序与三态 `role` / `state` / `multiple`）、`attachmentUploadPrecheck`
  （发送前拦超限与类型不符）、`attachmentBlobUrl` / `attachmentBindUrl`（URL 只由 entry + 固定路径拼）、
  `attachmentUploadFailure`（`code`/`statusCode`/`retriable` + `step`）。
- `components/EntityAttachmentUploads.tsx`：把入口画出来。`role` **不出现**、`state` 显示「当前状态只读」、
  `multiple` 说明「已有 N 个」。文件选择器是 `<label>` + 隐藏 `<input type="file">`（不做拖拽/多选/续传）。
- `components/EntityPanel.tsx`：附件页把上面两块接起来；上传成功后 `load()` 重新读实体（列表、rN、
  来源 rN 都来自基座的回答，不在浏览器里拼行）。
- `app/api/entity/attachment/blob/route.ts`：第一步 `POST {entry root}/blobs?category=…`，转发
  `multipart/form-data`（浏览器给的文件名与真实 content-type）。**不要改成裸字节**：基座的裸字节通道只收
  `application/octet-stream`，会丢掉 media type，随后被分类自己的 `contentTypes` 判 415。
- `app/api/entity/attachment/bind/route.ts`：第二步 `POST {entry root}/entities/{key}/attachments`，
  body `{blobId, category, fileName?}`。**不带 `expectedRevision`**：上传不携带字段值，没有可覆盖的东西，
  带上只会把「别人刚推进了状态」变成上传失败。
- `app/api/entity/attachment/route.ts`：下载（未改）。仍支持 `revision` / `asOf`——REST 能力不收缩，
  只是面板不再传。

## 三条硬约束

1. **凭据只属于 entry。** 三个代理都用 `mcp.json` 里那条 entry 的 `Authorization`，上游 URL 一律
   `entry + 固定路径`（`lib/entity-attachment-proxy.ts` 负责解析 entry）。不接受调用方给的目标。
2. **预检不编数字。** 分类声明了 `maxSizeMb` 才拦；没声明就交给基座的全局限额（客户端不硬编码，
   它的 413 里有 `limitBytes`）。`contentTypes` 支持 `*/*` 与 `type/*`，与基座同一套匹配；
   浏览器报不出类型（`file.type === ""`）时不猜，让基座的 415 说话。
3. **失败要说清哪一步。** `step: "content" | "bind"`：同样是 403，传内容失败是「身份不能存内容」，
   绑定失败是「这个分类在当前状态/角色下不可写」。面板把两者分别写成「传内容失败：」「绑定失败：」，
   并把 `code · HTTP n · 可重试/需处理后再试` 一起显示（AC-6）。

## 已知缺口（本单不做）

解绑/删除、多文件批量、拖拽、断点续传、附件描述编辑；面板里没有「历史版本」入口。
503（存储不可用）的可读映射由单测覆盖，没有对着共享测试栈把存储打挂来实测。
