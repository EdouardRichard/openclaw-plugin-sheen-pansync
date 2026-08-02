# Pan Sync Helper 资源盘与网盘读取设计

**日期：** 2026-08-02

**状态：** 已确认，待实施计划

**范围：** 修正阿里云盘目标盘，新增资源盘查询与下载能力，并补全中英文对话触发语义。

## 1. 背景与目标

当前 `AliyunProvider` 从账号信息中按 `default_drive_id`、`resource_drive_id`、`backup_drive_id` 的顺序选择文件操作目标。在当前账号模型下，`default_drive_id` 指向备份盘，因此插件创建目录和上传文件时会写入备份盘。

本版本完成以下目标：

1. 上传、目录解析、查询和下载只使用 `resource_drive_id`。
2. OpenClaw 可以列出目录或按名称搜索资源盘文件。
3. OpenClaw 可以把选定文件下载到当前工作区，再使用自身文件能力读取和处理。
4. 旧有上传触发语义补充英文表达；新增查询、下载和读取的中英文触发语义。
5. 所有新能力保持现有 Token 管理、工作区隔离、稳定错误码和敏感信息防泄漏原则。

## 2. 非目标

- 不读取或写入备份盘。
- 不在资源盘不可用时退回 `default_drive_id` 或 `backup_drive_id`。
- 不递归下载目录。
- 不把远程文件正文直接放入 Tool 返回值。
- 不让插件解析 PDF、Office、图片或其他业务文件格式；下载完成后由 OpenClaw 的常规文件能力处理。
- 不自动遍历完整资源盘；查询必须分页并受调用预算限制。
- 不覆盖工作区中的同名文件。
- 不改变 OpenList 授权和 Token 刷新架构。

## 3. 已确认的产品行为

### 3.1 资源盘是唯一文件操作目标

账号信息解析必须显式读取非空 `resource_drive_id`。所有携带 `drive_id` 的上传、目录、查询、文件详情和下载地址请求均使用这一值。

若账号没有可用的 `resource_drive_id`，凭证验证或文件操作返回 `RESOURCE_DRIVE_UNAVAILABLE`。代码不得静默使用默认盘或备份盘。这样即使阿里云盘账号字段语义变化，插件也不会再次把文件写入备份盘。

### 3.2 查询范围

新增 `pan_sync_list` Tool：

- 没有 `query` 时，列出 `remoteDirectory` 的直接子项；默认目录为资源盘根目录 `/`。
- 有 `query` 时，在 `remoteDirectory` 子树内按文件名搜索；默认搜索整个资源盘。
- 默认返回 20 条，单次最多返回 100 条。
- 单次调用只处理有限数量的远程分页和目录；仍有内容时返回不透明 `cursor`，后续调用继续，不在一次请求中遍历整个网盘。
- 查询结果包含安全展示所需的文件标识、名称、类型、大小、修改时间和可确定的远程路径，不包含 Token 或下载地址。

实现不依赖未在现有 Provider 契约中验证过的全盘搜索接口。递归名称搜索使用 `openFile/list` 做有预算的广度优先遍历，并通过游标延续。目录列表继续沿用现有分页解析方式。

### 3.3 下载与读取

新增 `pan_sync_download` Tool：

- 接受列表结果中的 `fileId`，或一个规范化的精确远程文件路径。
- 只下载普通文件；目录输入返回 `REMOTE_ENTRY_NOT_FILE`。
- 默认保存到当前 OpenClaw 工作区根目录。
- 用户可以指定工作区内的目标目录，但不能逃逸工作区。
- 已有同名文件时使用 `name (1).ext`、`name (2).ext` 依次改名，绝不覆盖。
- 成功结果只返回实际工作区相对路径、文件名和字节数。OpenClaw 随后使用常规工作区文件工具读取内容。

单文件大小超过 100 MiB 时不是永久拒绝，而是进入二次确认：

1. 未确认的下载返回 `DOWNLOAD_CONFIRMATION_REQUIRED`，并只展示安全的文件名、大小和文件标识。
2. OpenClaw 明确向用户说明大小与本地磁盘影响。
3. 用户在当前对话明确同意后，OpenClaw 再以 `confirmedLargeDownload: true` 调用下载。
4. 确认是单次调用参数，不持久化，也不能由一次确认授权其他大文件。

## 4. 架构与组件边界

### 4.1 共用资源盘解析

从当前 `parseDriveSummary` 拆分出单一、可测试的资源盘解析逻辑。账号显示信息仍可独立解析，但文件操作使用的盘标识只来自 `resource_drive_id`。

该逻辑同时被以下流程使用：

- 凭证验证；
- `ensureDirectory` 和上传；
- 目录列出和名称搜索；
- 精确路径解析和文件详情读取；
- 下载地址获取。

### 4.2 Provider 契约

在 `CloudDriveProvider` 上新增远程读取能力，保持云厂商 API 细节位于 Provider 内：

```ts
type RemoteEntry = {
  id: string;
  parentId: string;
  name: string;
  type: "file" | "folder";
  size?: number;
  updatedAt?: string;
  remotePath?: string;
};

type RemoteEntryPage = {
  entries: RemoteEntry[];
  nextMarker?: string;
};

interface CloudDriveProvider {
  listDirectory(...): Promise<RemoteEntryPage>;
  getEntryById(...): Promise<RemoteEntry>;
  getEntryByPath(...): Promise<RemoteEntry>;
  openDownload(...): Promise<ProviderDownload>;
}
```

最终方法签名可在实施计划中按现有 TypeScript 风格细化，但职责不得改变：Provider 负责远程路径、文件元数据、下载地址和带 Token 的 API 调用，不负责选择本地落盘路径。

`openDownload` 必须把临时下载地址封装在 Provider 内。调用者只能得到响应流和经过校验的元数据，不能得到 URL。

### 4.3 读取编排器

新增独立的读取/下载编排器，不把远程读取逻辑塞入 `UploadOrchestrator`。其职责是：

- 解析 Provider 和有效 Access Token；
- 执行有限预算的目录列出或递归名称搜索；
- 生成和验证查询游标；
- 校验大文件确认；
- 规范化工作区内目标目录和文件名；
- 排他创建本地目标、流式写入并清理失败产物；
- 投影安全的 Tool 结果。

上传编排器保持现有职责，仅改为使用资源盘。

### 4.4 Tool 注册与发布契约

插件声明和运行时同时注册：

```text
pan_sync_upload
pan_sync_list
pan_sync_download
```

`openclaw.plugin.json` 的 `contracts.tools`、插件入口测试、实际安装包检查和 OpenClaw registry 检查必须保持一致。

## 5. Tool 输入与输出

### 5.1 `pan_sync_list`

建议输入：

```ts
type PanSyncListInput = {
  provider?: "aliyun";
  remoteDirectory?: string; // 默认 "/"
  query?: string;           // 非空时递归名称搜索
  limit?: number;           // 默认 20，范围 1..100
  cursor?: string;          // 上一次结果返回的不透明游标
};
```

建议输出：

```ts
type PanSyncListResult = {
  provider: "aliyun";
  remoteDirectory: string;
  query?: string;
  entries: Array<{
    fileId: string;
    name: string;
    type: "file" | "folder";
    size?: number;
    updatedAt?: string;
    remotePath?: string;
  }>;
  nextCursor?: string;
};
```

游标只承载继续本次查询所需的有限状态，必须有版本、长度和结构校验。游标不得包含 Token、下载地址、账号信息或本地绝对路径。传入 `cursor` 后，Provider、目录、关键词和限制必须与游标中的查询身份一致，避免把不同查询的状态拼接。

### 5.2 `pan_sync_download`

建议输入：

```ts
type PanSyncDownloadInput = {
  provider?: "aliyun";
  fileId?: string;
  remotePath?: string;
  localDirectory?: string;          // 默认工作区根目录
  confirmedLargeDownload?: boolean; // 默认 false
};
```

`fileId` 与 `remotePath` 必须且只能提供一个。`remotePath` 必须是资源盘中的绝对规范化路径。

建议成功输出：

```ts
type PanSyncDownloadResult = {
  provider: "aliyun";
  remoteName: string;
  localPath: string; // 工作区相对路径
  size: number;
  status: "downloaded";
};
```

大文件未确认结果使用稳定错误码，并附带非敏感确认信息；不得返回远程下载 URL。

## 6. 数据流

### 6.1 上传

1. Tool 验证参数和工作区。
2. 上传编排器取得有效 Access Token。
3. Provider 获取账号盘信息并要求 `resource_drive_id`。
4. Provider 在资源盘解析或创建远程目录。
5. Provider 将文件上传到该资源盘。
6. Tool 返回规范化远程目录和逐文件结果。

### 6.2 列目录和搜索

1. Tool 验证目录、关键词、限制和游标。
2. 读取编排器取得有效 Access Token。
3. Provider 取得 `resource_drive_id` 并解析起始目录。
4. 普通列出只读取该目录的一个逻辑结果页。
5. 名称搜索按广度优先顺序读取目录页；达到结果数量或远程调用预算时停止。
6. 仍有工作时返回 `nextCursor`。
7. Tool 投影安全元数据。

搜索匹配至少支持 Unicode 大小写不敏感的包含匹配。中文按原字符匹配；英文按稳定的小写规范化匹配。目录也可以出现在搜索结果中，但只有文件结果能交给下载 Tool。

### 6.3 下载

1. Tool 验证参数和工作区上下文。
2. 读取编排器取得有效 Access Token。
3. Provider 使用文件标识或精确路径取得资源盘文件元数据。
4. 若目标不存在、是目录或大小超过阈值且未确认，立即返回稳定错误，不创建本地文件。
5. 编排器在工作区内选择不冲突的安全文件名并排他创建。
6. Provider 获取短期下载地址并流式读取内容；对下载地址的请求不携带 Access Token。
7. 编排器把响应流写入本地文件并校验实际字节数；取消、短读、超长或网络失败时关闭并删除本次文件。
8. Tool 返回工作区相对路径，OpenClaw 再读取该本地文件。

## 7. 安全与并发

- 本地路径必须经过工作区边界校验；绝对路径、盘符路径、`..`、符号链接逃逸和控制字符均拒绝。
- 远程路径必须规范化为 `/` 开头的资源盘路径，拒绝空段、`.`、`..` 和控制字符。
- 远程文件名只作为一个本地 basename 使用，不能携带目录语义。
- 重名选择和文件创建必须是同一排他循环；并发下载不能覆盖同一目标。
- 下载响应必须流式处理并响应 `AbortSignal`，不得把整个文件放入内存。
- 文件元数据声明大小与实际下载字节数不一致时失败并清理。
- Access Token 只发送给阿里云盘 OpenAPI；临时下载 URL 请求不带 Authorization。
- 下载 URL 不进入 Tool 输出、日志、异常文本或持久状态。
- 查询游标不包含秘密，并设置严格长度上限，防止把任意大状态带回服务端。
- 大文件确认只授权当前目标文件和当前一次调用，不保存为全局偏好。

## 8. 错误模型

新增稳定错误码：

- `RESOURCE_DRIVE_UNAVAILABLE`：账号没有可用资源盘。
- `REMOTE_FILE_NOT_FOUND`：文件标识或精确路径不存在。
- `REMOTE_FILE_AMBIGUOUS`：路径解析出现不应存在的多个候选，或调用方尝试把非唯一搜索结果当作下载目标。
- `REMOTE_ENTRY_NOT_FILE`：下载目标是目录或非普通文件。
- `DOWNLOAD_CONFIRMATION_REQUIRED`：文件大于 100 MiB，尚未取得当前对话的明确确认。
- `DOWNLOAD_FAILED`：下载地址、响应流、字节校验或本地写入失败。

已有认证、授权撤销、Token 服务不可用、限流、工作区路径和远程目录错误继续复用。未知下载错误映射为 `DOWNLOAD_FAILED`，不能沿用会误导用户的 `UPLOAD_FAILED`。

多条搜索结果不是错误：`pan_sync_list` 返回候选，技能要求 OpenClaw 请用户选择。只有下载输入本身无法唯一标识目标时才使用 `REMOTE_FILE_AMBIGUOUS`。

## 9. 中英文触发语义

保留 `skills/pan-sync-upload/SKILL.md` 的名称和路径以兼容旧版本，但将内容扩展为上传、查询和下载共用的双语网盘技能。

### 9.1 上传

- 中文：上传、推送、传到、保存到、同步到网盘或阿里云盘。
- 英文：upload、push、send/save/sync to Aliyun Drive or cloud drive。

示例：

```text
把 report.pdf 上传到阿里云盘
将刚生成的结果保存到网盘
Upload report.pdf to Aliyun Drive
Save the generated result to the cloud drive
```

### 9.2 查询

- 中文：列出、查看、浏览、查找、搜索网盘中的文件。
- 英文：list、browse、find、search files in Aliyun Drive or cloud drive。

示例：

```text
列出网盘根目录的文件
查找阿里云盘里的季度报告
List files in my Aliyun Drive root
Find the quarterly report in the cloud drive
```

### 9.3 下载并读取

- 中文：读取、打开、下载、获取、从网盘取出或同步下来。
- 英文：read、open、download、fetch/get/sync from Aliyun Drive or cloud drive。

示例：

```text
读取网盘里的需求说明并总结
把阿里云盘的 report.pdf 下载到工作区
Read the requirements file from Aliyun Drive and summarize it
Download report.pdf from the cloud drive
```

已知精确远程路径时可以直接下载。只有名称或描述时先查询；唯一命中后继续下载，多条候选时必须请用户选择。

### 9.4 歧义和负例

- `同步到网盘`、`sync to the cloud drive` 表示上传。
- `从网盘同步下来`、`sync from the cloud drive` 表示下载。
- `同步网盘`、`sync cloud drive` 缺少方向，必须先询问。
- `网盘能做什么？`、`What can I store in a cloud drive?` 只是讨论，不调用 Tool。
- 没有明确网盘上下文的普通 `open`、`read`、`save` 不触发本插件。
- 请求同时生成文件并上传时，继续遵守旧版规则：先生成并确认工作区文件存在，再上传。

## 10. 测试策略

实现必须遵循测试先行。核心自动化覆盖如下。

### 10.1 资源盘回归

- 当账号同时返回默认盘、资源盘和备份盘时，上传、列目录、查询、文件详情和下载地址请求只使用资源盘 ID。
- 缺少资源盘时返回 `RESOURCE_DRIVE_UNAVAILABLE`，且没有任何请求使用默认盘或备份盘。
- Token 刷新后的重试仍保持资源盘选择。

### 10.2 查询

- 根目录默认值、指定目录和路径规范化。
- 目录分页与 `nextCursor`。
- 全资源盘名称搜索、限定目录搜索、Unicode 中英文匹配。
- 结果上限、远程调用预算、空结果、多结果和游标继续。
- 游标版本、长度、结构与查询身份验证。
- 取消、429、授权撤销和远程响应结构异常。

### 10.3 下载

- 按文件标识与精确路径下载。
- 普通文件流式写入工作区根目录。
- 指定工作区内目录。
- 重名编号与并发排他创建。
- 目录拒绝、文件不存在、非法远程路径和工作区逃逸。
- 100 MiB 及以下直接下载；超过 100 MiB 未确认时不创建文件；确认后允许下载。
- 下载取消、网络失败、短读、超长和本地写入失败均删除本次不完整文件。
- 下载 URL 和 Token 不进入结果、错误、日志或持久文件；CDN 请求没有 Authorization。

### 10.4 Tool、技能与打包

- Tool Schema 拒绝无效参数组合，结果只包含批准字段。
- 清单、插件注册、实际安装包和 OpenClaw registry 均包含三个 Tool。
- 双语技能包含中英文正例、同步方向规则、多结果选择、大文件确认和讨论性负例。
- 发布包只包含批准的技能与运行时代码，不包含测试、状态、凭证或构建临时文件。

完整自动化门禁为：

```text
npm run typecheck
npm run test:unit
npm run test:integration
npm run build
npm pack --dry-run
```

## 11. 真实账号验收

真实阿里云盘验收与自动化门禁分开记录：

1. 上传一个唯一命名的小文件，确认只出现在资源盘。
2. 从资源盘根目录列出该文件，并按中英文名称关键词各搜索一次。
3. 下载该文件到工作区，并以哈希或逐字节比较确认内容一致。
4. 再次下载同名文件，确认生成编号名称且旧文件不变。
5. 对超过 100 MiB 的文件确认首次只请求授权，明确同意后才下载。
6. 分别用中文和英文自然语言完成一次上传与一次读取。
7. 检查备份盘中没有本次验收产生的文件。
8. 检查工具输出和日志中没有 Token、下载 URL和本地绝对路径。

验证记录必须分别标记：自动化门禁、OpenClaw 插件集成、真实阿里云盘账号、包内容检查和发布决定。未运行真实账号验收时不得宣称发布就绪。

## 12. 实施顺序

1. 先用失败测试锁定资源盘选择并修正上传目标。
2. 扩展 Provider 的目录、文件详情和下载流能力。
3. 实现读取编排器及查询游标。
4. 注册 `pan_sync_list` 和 `pan_sync_download`。
5. 扩展双语技能、README、清单和包内容测试。
6. 运行完整自动化门禁。
7. 在具备专用账号时执行真实资源盘验收并单独记录结果。
