# 数字展品使用授权核验应用

供小型展馆在选取数字展品组成展览包时，沿**全部来源链**逐节点核验使用授权（媒介、地区、有效期、撤销状态），并在发布时**原子保存不可变的核验快照与素材清单**。授权随后变更时自动重算资格，仅把“由合格变不合格”的已发布包标记为**需复核**，原快照始终保留。

策展人还可为待发布包编排**多站巡展**：每站单独填写名称、展示媒介、地区及起止日期，按顺序展出（站间不得重叠，首尾日期均算占用），整包共享同一份入展素材清单。核验**逐站沿全部来源链**检查每个节点有一份未撤销授权独自覆盖该站整段展期——不同站可用不同授权，**同站不可拼接短授权**；发布在同一事务内重读行程、清单与授权依据，任一站失败则整包不发布。既有单站包的请求/响应完全兼容，旧包一律视为单站。

策展人还可对待发布/需复核包**录入若干拟取得的授权报价**（素材、媒介、地区、有效期、非负整数成本），系统基于当前授权与来源关系，只读算出**总成本最低的报价组合**（共享节点只算一次、一份报价可覆盖多站、同站短授权不得拼接；并列时报价数少者优先，再按输入序号字典序），并在网页与 `POST /api/packages/:id/quotes/preview` 中展示方案或按站列出缺口与来源路径；预览不写入任何数据，已发布包不可预览。

- 后端：Node.js 20 + Express + better-sqlite3（SQLite，同步事务）
- 前端：原生 HTML/CSS/JS，无构建步骤
- 交付：Dockerfile + docker-compose 一键启动，数据库自动初始化

---

## 一、一键启动（Docker Compose，推荐）

前置：已安装 Docker 与 Docker Compose 插件。

```bash
docker compose up --build -d
```

启动后打开浏览器：

- **Web 地址：http://localhost:3000**

首次启动会自动建表并写入一份演示数据（由 `SEED_DEMO=1` 控制；数据库非空时自动跳过）。
停止 / 查看日志：

```bash
docker compose logs -f
docker compose down            # 停止（数据保留在命名卷 exhibit-data 中）
docker compose down -v         # 停止并删除数据库卷（清空全部数据）
```

## 二、本机直接运行（不用 Docker）

前置：Node.js ≥ 20。better-sqlite3 会优先下载预编译二进制；若本机无编译环境且无法访问 GitHub，可使用 npmmirror 镜像：

```bash
# 安装依赖（两种方式任选）
npm ci || npm install
# 若卡在 better-sqlite3 预编译下载，可指定镜像后重试：
# npm_config_better_sqlite3_binary_host_mirror=https://registry.npmmirror.com/-/binary/better-sqlite3 npm install

# 可选：初始化演示数据
npm run seed

# 启动
npm start
# → http://localhost:3000
```

运行自检（需先启动服务）：

```bash
node test/e2e.js          # 原有核验/发布/预演/档期/多站规则（148 项）
node test/quotes-e2e.js   # 授权报价方案规则（52 项）
```

---

## 三、使用流程

界面分两个标签页：

1. **素材与来源**
   - 登记素材（名称、类型、备注）。
   - 维护来源关系：「本素材 使用了 ← 来源素材」。关系按边逐条核验，添加会成环的边将被拒绝并提示完整闭环。
   - 登记授权：媒介、地区、有效期（起止日期）、撤销状态、授权方。媒介或地区填 `*` 表示通配任意值；匹配忽略大小写；有效期按闭区间覆盖整段使用期（`valid_from <= 使用起始` 且 `valid_to >= 使用截止`），已撤销授权一律不计入。
2. **展览包与核验发布**
   - 新建待发布包：默认是**单站展**，填展示媒介、地区、起止日期，勾选入展素材（系统会自动纳入其全部上游来源节点）。
   - 勾选「**多站巡展**」后切换为按站编排：逐站填写**站点名称、展示媒介、展示地区、起止日期**，可增删任意站数（至少 2 站）。站按表格顺序展出，**相邻站不得重叠**（首尾日期均算占用：后一站起始日须晚于前一站截止日）；整包共享同一份勾选的入展素材清单。多站行程仅在包处于待发布时可改，发布后冻结。
   - 点「核验」：
     - 单站包：沿每个入展品的**全部**来源路径遍历，逐节点检查是否至少有一份“未撤销 + 媒介命中 + 地区命中 + 覆盖整段使用期”的授权。
     - 多站包：共享来源链只遍历一次，然后**逐站**用该站自己的媒介/地区/展期判定。结果按站列出本站结论，失格站下展开问题节点、原因（无授权 / 全部撤销 / 媒介不符 / 地区不符 / 日期不覆盖（短授权不可拼接）/ 成环）及该节点的**全部来源路径**（入展品 → … → 问题节点）；任一站失格则整包不合格。
     - 行程层面的全局错误（缺站名/媒介/地区、日期不合法或倒置、站间重叠）会在顶部逐条列出并标出站次。
   - 点「按此次核验结果原子发布」：
     - 服务端在**单个事务内重新读取并重算**——多站包会重读**完整行程（`package_stops`）、素材清单与授权依据**，逐站重算；任一不符或任一站不合格都整体回滚，**整包不发布**。
     - 核验之后授权或来源关系被任何人修改过，返回 `409 STALE_BASIS`，拒绝发布并提示重新核验；
     - 核验不通过（含某站缺授权、行程非法、站间重叠等）返回 `422`，包保持“待发布”，但本次尝试同样留存为不可变记录；
     - 通过则在**单个 SQLite 事务**内写入不可变核验快照（多站：完整**逐站逐节点**结果 JSON + 冻结行程与清单 + 依据版本）并置为“已发布”，同时冻结各站（非待发布包的站次表被触发器拒绝改/删）。

### 授权变更后的行为（先预演、再确认）

- 授权的**单笔增/改/撤/删**或来源关系的**单条增/删**，界面默认「先做影响预演，再确认提交」（右上角开关可关闭，关闭后走既有编辑接口直接保存，行为与旧版一致）。
- 预演输入字段沿用对应现有编辑接口与校验（媒介/地区非空、日期合法且起不晚于止、不得自环、新增来源不得成环等）；**预演只读**，在回滚型事务中模拟变更并重算，只返回：
  - 因该变更将**由合格转为不合格的已发布展览包**（需复核包/待发布包不在其列）；
  - **单站包**：问题节点、原因（无授权 / 全部撤销 / 媒介不符 / 地区不符 / 日期不覆盖等）及全部来源路径；
  - **多站包**：`multiStop:true` + `failingStops`，**按站**列出因此失格的站次（只含失格站）、每站的媒介/地区/展期与该站的问题节点、原因及全部来源路径；
  - 预演所依据的 `basisVersion` 与影响清单指纹；预演**不改动**授权、关系、行程、包状态或快照，依据版本也不变。
- 确认时把**同一操作字段连同预演结果**（`basisVersion` + `impact`）一起提交。服务端在**单个事务内**：核对依据版本 → 重新校验输入/目标/成环 → 应用变更并重算影响 → 与预演清单比对 → 全部通过才提交。任一不符整体回滚、**无部分写入**：
  - 依据版本不一致 → `409 STALE_BASIS`；
  - 影响清单与重算结果不一致 → `409 IMPACT_MISMATCH`（响应里附服务端最新影响清单）；
  - 预演后目标（授权/来源边）被删除或素材失效 → `409 TARGET_GONE`；
  - 输入非法 → `400`；成环 → `409 CYCLE`（含 `cyclePath`/`cycle`）。
  - 界面在过期/漂移时给出过期提示并可一键「重新预演」后再确认。
- 成功后按现有规则执行：变更落库、仅把“合格→不合格”的已发布包置为 `needs_review` 并**追加**不可变复核快照；原发布快照一行不改、不会删除。
- 需复核包不会自动恢复。补正授权后，在界面点「重新核验（人工复核）」：单站包合格即恢复为已发布；**多站包须全部站点合格**才恢复，只要还有一站失格就保持需复核；两种结果都会再追加一条快照。
- 已有编辑接口（直接增删改）的请求与返回保持兼容；已发布/需复核包的参数、清单与（多站）行程仍不可编辑、不可删除，需要调整时点「复制为待发布包」——多站行程会随副本复制，副本为待发布，可继续编排。

### 多站巡展（为待发布包编排多站行程）

- 仅**待发布**包可编排多站行程（至少 2 站）；单站包依旧使用包顶层媒介/地区/起止日期。既有包（含旧版本创建的包）一律视为单站：DTO 为 `multiStop:false, stopCount:0, stops:[]`，请求与响应字段均保持兼容。
- 每站独立填写 `name`（站点名称）、`media`（展示媒介，兼容 `medium`）、`region`（地区）、`useFrom`/`useTo`（起止日期）；站按提交顺序展出。
- **站间不得重叠**：首尾日期均算占用，相邻站必须满足 `后一站.useFrom > 前一站.useTo`（同日衔接也算重叠，保存时返回 `409 STOPS_OVERLAP` 并指出是哪两站）。
- 整包共享一份入展素材清单（及其全部来源链）；来源结构只遍历一次，各站复用同一份全部来源路径。
- **逐站核验**：每个节点在每个站都必须有**一份**未撤销、媒介命中（`*` 通配、忽略大小写）、地区命中、有效期闭区间覆盖**该站整段展期**的授权。不同站可以命中不同授权；同一站不能用多份短授权拼接。
- 多站包**不适用**档期搜索/改期：对多站包调用档期接口返回 `409 MULTI_STOP_UNSUPPORTED`；档期搜索仍然只服务于单站包。
- 编辑已保存的多站待发布包时，请求体必须继续携带完整 `stops`（否则 `400 STOPS_REQUIRED`）；单站与多站形态不能互相转换，需要改形态请新建包。

### 档期规划（仅单站包：为待发布包选可用起始日）

策展人可为**待发布单站**包输入规划起止日，系统按包**当前展期天数（含首尾）**，在规划窗口内查找**完整落在窗口内**的可用起始日（**多站巡展包调用本接口会被明确拒绝：`409 MULTI_STOP_UNSUPPORTED`**）：

- 对**入展素材及其全部上游来源节点**逐一判定：每个起始日对应的展期，节点必须被**同一份**未撤销、媒介与地区匹配（`*` 通配、忽略大小写）的授权**完整覆盖**（闭区间）。不同节点可以用不同授权；同一节点的**短授权不可拼接**——每份授权按展期天数折算为一段可行起始日区间（`valid_from ≤ 起始日` 且 `valid_to ≥ 起始日 + 天数 − 1`），不足整段的短授权折算为空。
- 结果按日期**升序合并连续可行起始日**，逐段给出范围与该段的**最早展期**；窗口放不下整段展期时明确提示窗口过短。
- **无结果**时，列出各**受限节点在窗口内各自的可用起始日范围**（及无授权/全撤销/媒介不符/地区不符/短授权不可拼接等原因），用以解释各节点范围的交集为何为空；全窗口都可用的节点不构成约束，不列出。
- 空包、包当前展期缺失或非法、规划窗口非法均直接报 `400`；已发布/需复核包搜索档期报 `409 NOT_DRAFT`（请用「复制为待发布包」）。

**选定档期**时把搜索返回的 `searchToken` 与起始日回传，服务端在**单个事务内重验**，下列任一变化都**整体拒绝且不改包**：

| 拒绝码 | 触发条件 |
| --- | --- |
| `409 STALE_BASIS` | 搜索后授权或来源关系被增删改（核验依据版本变化） |
| `409 PACKAGE_CHANGED` | 搜索后包参数（媒介/地区/展期）或素材清单被修改（或被清空） |
| `409 NOT_DRAFT` | 包已不再是待发布状态（已被发布等） |
| `409 SLOT_INVALID` | 选定起始日落出搜索窗口，或其展期在当前授权下已不被完整覆盖（附失效节点） |
| `409 TOKEN_MISMATCH` | 搜索令牌不属于该包或内容损坏 |

改期只更新待发布包的起止日期（展期天数保持不变），不发布、不写核验快照、不动清单；随后仍走既有「核验 → 发布」流程。

### 拟取得授权报价方案（只读预览，为待发布/需复核包选最低成本报价组合）

策展人可为**待发布或需复核**展览包录入若干「拟取得的授权报价」（每项注明**素材、媒介、地区、有效期和非负整数成本**），系统基于**同一份当前授权与来源关系**计算最低成本方案——全程**只读，不写入授权、包、状态或快照**；**已发布包不可预览**（请先「复制为待发布包」）。

- 覆盖判定与核验完全一致：每站每个**入展素材及其全部来源节点**，须由一份**现有有效授权**或一份**所选报价独自覆盖该站整段展期**（未撤销、`*` 通配媒介/地区、忽略大小写、闭区间覆盖）；**共享来源节点只核算一次，一份报价可覆盖多站，同站短授权/短报价不得拼接**。
- 各素材节点的报价彼此独立，逐节点解集合覆盖：先比**总成本最低**；总成本并列时取**报价数少者**；仍并列再按**输入序号序列**取**字典序最小**。
- **有解**时给出：总成本、选中报价（按输入序号）及其覆盖的「站 × 节点」清单、逐站逐节点覆盖矩阵（现有授权 / 报价）、未入选报价的提示（无需取得 / 不能覆盖 / 不属本包）。
- **无解**时列出仍缺授权的**站次、节点、原因（无报价 / 媒介不符 / 地区不符 / 日期不覆盖（短报价不可拼接））与该节点的全部来源路径**。
- **拒绝预览（不落任何数据）并说明原因**：报价指向不存在的素材、字段缺失（媒介/地区）、日期非法或起止倒置、成本不是非负整数、报价数量超上限、空包、包行程非法或来源链无法完整核验（成环/超深/路径超限）、包已发布。
- 需复核包同样可预览（用于估算补授权成本）；预览不改其状态、不追加快照。

---

## 四、核验规则要点

| 规则 | 说明 |
| --- | --- |
| 来源方向 | 边 `素材 → 来源素材`；核验自入展品沿边向上游遍历全部路径 |
| 成环 | 新增边前做可达性预判（若来源已能到达本素材则拒绝）；核验时 DFS 再次检测并把环上节点列为不合格 |
| 授权命中 | 未撤销；媒介相等或授权媒介为 `*`；地区相等或授权地区为 `*`（忽略大小写） |
| 日期覆盖 | `授权.valid_from ≤ 使用起始` 且 `授权.valid_to ≥ 使用截止`（闭区间） |
| 节点合格（单站） | 至少一份授权同时满足上述全部条件（单份授权必须独自覆盖整段使用期，不跨授权拼接） |
| 多站核验 | 整包共享清单与来源链，**逐站**判定；每站每个节点须有一份未撤销授权独自覆盖**该站**整段展期；不同站可用不同授权，同站短授权不可拼接；**任一站失格即整包不合格** |
| 站间不重叠 | 站按顺序展出，首尾日均占用：`stops[i+1].useFrom > stops[i].useTo`，否则保存/核验失败 |
| 行程冻结 | 多站行程仅待发布可改；`package_stops` 上的 `BEFORE UPDATE/DELETE` 触发器拒绝改动非待发布包的站次 |
| 发布闸门 | 无全局错误、无缺失素材、无环、无不合格节点（多站：全部站全部节点），且依据版本未过期 |

不可变性由数据库强制：`verification_snapshots` 表与多站包发布后的 `package_stops` 行上配置了 `BEFORE UPDATE` / `BEFORE DELETE` 触发器，任何修改或删除都会被 SQLite 直接拒绝。

## 五、配置项（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DB_PATH` | 本地 `./data/app.db`（容器内 `/data/app.db`） | SQLite 数据库文件路径，所在目录自动创建 |
| `SEED_DEMO` | `0`（compose 中为 `1`） | 启动时若库为空则写入演示数据 |

修改端口（例如改为 8080）：编辑 `docker-compose.yml` 的 `ports: - "8080:3000"`（宿主机端口:容器端口），或直接运行时 `-e PORT=...` 并同步映射。

## 六、数据持久化与备份

- Compose 使用命名卷 `exhibit-data` 挂载到容器 `/data`，数据库（WAL 模式）在 `docker compose down` 后仍然保留。
- 备份：`docker compose exec exhibit-auth node -e "const db=require('better-sqlite3')(process.env.DB_PATH);db.backup('/data/backup.db').then(()=>process.exit(0))"` 后从卷中取 `/data/backup.db`；或停服后直接复制 `app.db`、`app.db-wal`、`app.db-shm`。

## 七、主要 HTTP API

| 方法 路径 | 作用 |
| --- | --- |
| `GET /api/state` | 依据版本与计数 |
| `GET/POST /api/materials` · `PATCH/DELETE /api/materials/:id` | 素材 CRUD |
| `POST /api/materials/:id/sources` · `DELETE /api/source-links/:id` | 来源关系（成环返回 409 + `cyclePath`/`cycle`） |
| `POST /api/materials/:id/authorizations` · `PATCH /api/authorizations/:id` · `POST /api/authorizations/:id/revoke` · `DELETE` | 授权登记/修改/撤销/删除 |
| `GET/POST /api/packages` · `PATCH/DELETE /api/packages/:id` · `POST /api/packages/:id/copy` | 展览包（POST/PATCH 传 `stops` 数组即多站包；`copy` 会复制行程） |
| `POST /api/verify` | 试核验（body 可传 `packageId`、单站完整字段，或 `{materialIds, stops[]}` 即席多站核验） |
| `POST /api/packages/:id/schedule/search` | **档期搜索（仅单站）**：多站包返回 `409 MULTI_STOP_UNSUPPORTED` |
| `POST /api/packages/:id/schedule/apply` | **选定档期改期（仅单站）**：多站包同样 `409 MULTI_STOP_UNSUPPORTED` |
| `POST /api/packages/:id/quotes/preview` | **授权报价方案预览（只读）**：为待发布/需复核包计算最低成本报价组合；已发布包 `409 PUBLISHED_NO_PREVIEW` |
| `POST /api/packages/:id/publish` | 发布，body 需含核验时的 `basisVersion`；事务内重读行程/清单/依据，过期 409、任一站不合格 422 |
| `POST /api/packages/:id/recheck` | 对需复核包人工重新核验 |
| `POST /api/changes/preview` | **变更影响预演**（只读）：单笔授权增改撤删 / 单条来源增删，返回将由合格转不合格的已发布包、问题节点、原因与依据版本 |
| `POST /api/changes/commit` | **确认提交同一操作 + 预演结果**：事务内核版本、重算并比对影响清单；过期/不一致/目标失效/非法均整体拒绝 |
| `GET /api/snapshots/:id` | 读取不可变快照完整内容 |

### 多站巡展 API 调用示例

新建/保存待发布包时，除顶层 `name` 与 `materialIds`（整包共享）外，传 `stops` 数组（≥2 站）即为多站包；不传 `stops` 即既有单站包（兼容）。

第 1 步——创建多站待发布包：

```bash
curl -s -X POST http://localhost:3000/api/packages \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "2026 双城巡展包",
    "materialIds": [1],
    "stops": [
      { "name": "北京首展", "media": "屏幕放映",   "region": "中国大陆",
        "useFrom": "2026-03-01", "useTo": "2026-03-20" },
      { "name": "香港巡展", "media": "沉浸式投影", "region": "中国香港",
        "useFrom": "2026-05-01", "useTo": "2026-05-20" }
    ]
  }'
# → { "id": 12, "multiStop": true, "stopCount": 2, "stops": [ {position:0,…}, {position:1,…} ],
#     "medium": "屏幕放映", "useFrom": "2026-03-01", …  /* 顶层字段取首站，供旧界面展示 */
#     "items": [ …整包共享清单… ] }
```

第 2 步——逐站核验（`/api/verify` 传 `packageId` 自动按存储形态走单站或多站；也可不建包直接传 `materialIds + stops` 即席核验）：

```bash
curl -s -X POST http://localhost:3000/api/verify -H 'Content-Type: application/json' \
  -d '{"packageId": 12}'
# → { "multiStop": true, "eligible": false, "basisVersion": 22,
#     "globalErrors": [],
#     "stats": { "stopCount": 2, "failingStopCount": 1, "rootCount": 1, "nodeCount": 5, … },
#     "stops": [
#       { "position": 0, "name": "北京首展", "medium": "屏幕放映", "region": "中国大陆",
#         "useFrom": "2026-03-01", "useTo": "2026-03-20", "eligible": true, "failingNodes": [], "nodes": [ … ] },
#       { "position": 1, "name": "香港巡展", "medium": "沉浸式投影", "region": "中国香港",
#         "useFrom": "2026-05-01", "useTo": "2026-05-20", "eligible": false,
#         "failingNodes": [
#           { "materialId": 4, "title": "标题字体“展宋”", "isRoot": false,
#             "reasons": ["date"], "reasonText": ["该站：无任何一份授权能独自覆盖该站整段展期（短授权不可拼接）"],
#             "paths": [ [ {"materialId":1,…}, {"materialId":4,…} ] ] } ] } ] }
```

第 3 步——整包发布（同一事务内重读行程、清单与授权依据；任一站失败则整包不发布）：

```bash
curl -s -X POST http://localhost:3000/api/packages/12/publish \
  -H 'Content-Type: application/json' -d '{"basisVersion": 22}'
# 全站合格 → 201：package.status="published"，result.multiStop=true，
#   result.stops[*] 冻结各站逐节点结果，result.request.stops 冻结行程，result.request.materialIds 冻结清单。
# 任一站失格 → 422（details.result 为完整逐站结果，包保持 draft，本次尝试仍追加不可变快照）。
# 核验后授权/来源有变更 → 409 STALE_BASIS。
```

多站包的拒绝码（均为 4xx，不产生部分写入）：

```text
400  INVALID_STOPS     stops 缺字段/不足 2 站、某站名/媒介/地区缺失、日期非法或倒置
409  STOPS_OVERLAP     相邻站展期重叠（首尾日均占用，后站起始须晚于前站截止）
400  STOPS_REQUIRED    编辑已保存的多站包时未提交完整 stops
409  MULTI_STOP_UNSUPPORTED  多站包调用档期搜索/改期（档期仅适用于单站）
409  STALE_BASIS / 422 …     发布闸门与单站一致，按“全站合格”判定
```

多站包的变更预演影响按站返回（`POST /api/changes/preview`）：

```jsonc
{ "operation": "authorization.revoke", "basisVersion": 22, "impact": [
  { "packageId": 12, "packageName": "2026 双城巡展包", "multiStop": true, "stopCount": 2,
    "failingStops": [
      { "position": 1, "name": "香港巡展", "medium": "沉浸式投影", "region": "中国香港",
        "useFrom": "2026-05-01", "useTo": "2026-05-20",
        "failingNodes": [ { "materialId": 4, "reasons": ["date"], "reasonText": ["…"], "paths": [ … ] } ] }
    ] } ] }
```

人工复核（`POST /api/packages/12/recheck`）对多站包要求**全部站点**合格才恢复为已发布，否则保持需复核；每次复核都追加一条 `recheck` 不可变快照。

### 影响预演 / 确认 API 调用示例

请求体里的 `operation` 标识操作类型，其余字段与对应既有编辑接口完全一致。

| operation | 对应既有接口 | 关键入参 |
| --- | --- | --- |
| `authorization.create` | `POST /api/materials/:id/authorizations` | `materialId, media, region, validFrom, validTo, revoked?, licensor?, note?` |
| `authorization.update` | `PATCH /api/authorizations/:id` | `authorizationId` + 需修改字段（缺省沿用现值，含 `revoked`） |
| `authorization.revoke` | `POST /api/authorizations/:id/revoke` | `authorizationId` |
| `authorization.delete` | `DELETE /api/authorizations/:id` | `authorizationId` |
| `source.create` | `POST /api/materials/:id/sources` | `materialId, sourceMaterialId, relation?` |
| `source.delete` | `DELETE /api/source-links/:id` | `linkId` |

第 1 步——预演（不落库）：

```bash
curl -s -X POST http://localhost:3000/api/changes/preview \
  -H 'Content-Type: application/json' \
  -d '{"operation":"authorization.revoke","authorizationId":3}'
# → { "ok": true, "basisVersion": 10,
#     "impact": [ { "packageId": 1, "packageName": "常设展…",
#                   "failingNodes": [ { "materialId": 3, "title": "城市航拍素材",
#                                       "reasons": ["revoked"],
#                                       "reasonText": ["该节点的授权均已撤销"],
#                                       "paths": [ [ {"materialId":1,…}, {"materialId":3,…} ] ] } ] } ],
#     "impactFingerprint": "…", "mutated": false }
```

第 2 步——把**同一操作字段**连同预演给出的 `basisVersion` 与 `impact` 原样回传确认：

```bash
curl -s -X POST http://localhost:3000/api/changes/commit \
  -H 'Content-Type: application/json' \
  -d '{"operation":"authorization.revoke","authorizationId":3,
       "basisVersion":10,"impact":[ /* 原样粘贴 preview 返回的 impact */ ]}'
# → { "ok": true, "mutated": true, "basisVersion": 11, "impact": [ …同清单… ],
#     "message": "变更已执行：1 个已发布包被标记为需复核并已追加不可变复核快照；需复核包不会自动恢复。" }
```

新增来源边的预演（成环在预演阶段即被拒绝）：

```bash
curl -s -X POST http://localhost:3000/api/changes/preview \
  -H 'Content-Type: application/json' \
  -d '{"operation":"source.create","materialId":1,"sourceMaterialId":6,"relation":"引用"}'
```

可能的拒绝（均为 4xx，且不产生任何写入）：

```text
400  输入非法（空媒介/地区、日期非法或倒置、自环、缺少 id、未知 operation）
409  CYCLE           新增来源将成环（details.cyclePath / details.cycle）
409  STALE_BASIS     预演后授权/来源被他人改过（details.clientBasis/currentBasis）
409  IMPACT_MISMATCH 影响清单与当前重算不符（details.impact 为最新清单，请重新预演）
409  TARGET_GONE     预演后目标授权/来源边已被删除
404  预演时目标不存在
```

### 档期规划 API 调用示例

第 1 步——为待发布包搜索可用起始日（只读）：

```bash
curl -s -X POST http://localhost:3000/api/packages/12/schedule/search \
  -H 'Content-Type: application/json' \
  -d '{"planFrom":"2026-06-01","planTo":"2026-09-30"}'
# → { "ok": true, "durationDays": 7, "feasible": true,
#     "ranges": [
#       { "startFrom": "2026-07-10", "startTo": "2026-08-09", "dayCount": 31,
#         "earliestExhibitionFrom": "2026-07-10", "earliestExhibitionTo": "2026-07-16" }
#     ],
#     "restrictedNodes": [],
#     "basisVersion": 22,
#     "searchToken": { "packageId": 12, "basisVersion": 22, "fingerprint": "…",
#                      "planFrom": "2026-06-01", "planTo": "2026-09-30", "durationDays": 7 } }
```

无结果时 `feasible:false`，`restrictedNodes` 给出每个受限节点在窗口内的可用起始日范围以解释交集；窗口过短时 `windowTooShort:true`。

第 2 步——选定某段范围内的起始日应用（在事务内重验）：

```bash
curl -s -X POST http://localhost:3000/api/packages/12/schedule/apply \
  -H 'Content-Type: application/json' \
  -d '{"useFrom":"2026-08-09","searchToken":{ /* 原样粘贴 search 返回的 searchToken */ }}'
# → { "ok": true, "useFrom": "2026-08-09", "useTo": "2026-08-15",
#     "durationDays": 7, "package": { …更新后的待发布包… } }
```

拒绝均为 4xx 且不改动包，例如搜索后授权被修改：

```text
400  EMPTY_PACKAGE / INVALID_WINDOW / INVALID_DATE / 缺令牌（空包、非法窗口/日期、缺 searchToken）
409  STALE_BASIS     搜索后授权或来源关系发生变化（details.clientBasis/currentBasis）
409  PACKAGE_CHANGED 搜索后包参数或素材清单发生变化
409  NOT_DRAFT       包已发布或处于需复核
409  SLOT_INVALID    选定起始日落出窗口或档期已失效（details.failingNodes 为失效节点）
409  TOKEN_MISMATCH  搜索令牌与目标包不一致或已损坏
```

> 注意：应用成功后 `searchToken` 即作废（包展期已变），需要再次改期请重新搜索。

### 授权报价方案 API 调用示例（只读预览）

为待发布/需复核包录入若干拟取得的授权报价（`cost` 为非负整数；字段语义与授权登记一致，`media` 兼容 `medium`），服务端基于当前授权与来源关系求解：

```bash
curl -s -X POST http://localhost:3000/api/packages/12/quotes/preview \
  -H 'Content-Type: application/json' \
  -d '{ "quotes": [
    { "materialId": 4, "media": "*", "region": "*",
      "validFrom": "2026-10-01", "validTo": "2026-11-30", "cost": 100, "licensor": "字库公司" },
    { "materialId": 5, "media": "屏幕放映", "region": "中国大陆",
      "validFrom": "2026-09-01", "validTo": "2026-12-31", "cost": 50 }
  ]}'
```

有解（`feasible:true`）：

```jsonc
{ "ok": true, "readOnly": true, "mutated": false, "packageId": 12, "status": "draft",
  "multiStop": false, "stopCount": 1, "basisVersion": 22, "quoteCount": 2,
  "feasible": true, "totalCost": 150, "selectedQuoteCount": 2,
  "selectedQuotes": [
    { "index": 1, "materialId": 4, "materialTitle": "标题字体“展宋”",
      "media": "*", "region": "*", "validFrom": "2026-10-01", "validTo": "2026-11-30",
      "cost": 100, "covers": [ {"stopPosition": 0, "stopName": "临时展屏展包…", "materialId": 4} ],
      "coveredStopCount": 1 },
    { "index": 2, "materialId": 5, "cost": 50, "coveredStopCount": 1, "covers": [ … ] }
  ],
  "stats": { "nodeCount": 5, "existingCoveredNodeStopCount": 3,
             "quoteCoveredNodeStopCount": 2, "gapCount": 0 },
  // 逐节点逐站覆盖依据：stops[站] = 现有授权 {type:"existing",authorizationId,…}
  //                     或所选报价 {type:"quote",quoteIndex,…}
  "nodes": [ { "materialId": 1, "cost": 0, "covered": true, "stops": [ {"type":"existing", …} ] }, … ],
  "gaps": [], "warnings": [] }
```

多站包中**一份报价覆盖多站**时，其成本只计一次，`covers` 会列出全部「站 × 节点」。

无解（`feasible:false`，`totalCost:null`，`gaps` 按站次、节点列出）：

```jsonc
{ "feasible": false, "totalCost": null,
  "gaps": [
    { "stopPosition": 1, "stopName": "香港巡展", "medium": "沉浸式投影", "region": "中国香港",
      "useFrom": "2026-05-01", "useTo": "2026-05-20",
      "materialId": 7, "title": "多站-来源", "isRoot": false,
      "reason": "date",
      "reasonText": "该站：现有授权不覆盖；没有任何一份报价能独自覆盖该站整段展期（短报价不可拼接）",
      "paths": [ [ {"materialId":6,"title":"多站-成片"}, {"materialId":7,"title":"多站-来源"} ] ] }
  ] }
```

决胜规则：`totalCost` 最小；并列取 `selectedQuoteCount` 最小；仍并列按所选报价的**输入序号序列**字典序最小（如 `[2,4]` 优先于 `[2,5]`、`[3,4]`）。

拒绝码（均为 4xx，且不产生任何写入，预览不改依据版本）：

```text
400  QUOTES_REQUIRED          缺少 quotes 数组（无报价请传 []）
400  TOO_MANY_QUOTES          报价数量超过单次预览上限（200 条）
400  QUOTE_INVALID            报价字段问题（details.errors 逐条列出）：
                              指向不存在素材（details.materialIds）、缺媒介/地区、
                              日期非法或起止倒置、成本不是非负整数
400  EMPTY_PACKAGE            包未选取任何素材
404                          展览包不存在
409  PUBLISHED_NO_PREVIEW     已发布包不可预览（请复制为待发布包）
422  UNVERIFIABLE             行程非法/站间重叠，或来源链成环、超深、路径数超安全上限
```

## 八、目录结构

```
.
├── Dockerfile              # 依赖安装 + 数据库初始化的多阶段镜像
├── docker-compose.yml      # 一键启动（端口 3000，命名卷持久化）
├── docker-entrypoint.sh    # 可选演示数据初始化后启动
├── package.json
├── src
│   ├── db.js               # SQLite 连接、建表（含 package_stops 行程表/冻结触发器）、版本号/快照不可变触发器
│   ├── verify.js           # 来源链遍历、成环检测、单站/多站逐节点授权核验、发布后重算
│   ├── schedule.js         # 档期规划（仅单站；多站包明确拒绝）：起始日折算/交集/合并、事务内重验改期
│   ├── changes.js          # 单笔变更影响预演（回滚型事务模拟）与确认提交（多站影响按站给出）
│   ├── quotes.js           # 拟取得授权报价方案（只读）：逐节点集合覆盖精确求解（成本→报价数→序号字典序）
│   ├── server.js           # Express API（多站行程编排、发布事务、依据过期拒绝、/api/changes/preview|commit、/quotes/preview）
│   └── seed.js             # 演示数据
├── public                  # 浏览器前端（无构建；含多站行程表格编辑器、按站结果渲染与报价方案弹层）
│   ├── index.html
│   ├── styles.css
│   └── app.js
└── test
    ├── e2e.js              # 端到端业务规则自检（148 项，含多站巡展 44 项）
    └── quotes-e2e.js       # 授权报价方案自检（52 项：最低成本/多站共享/并列决胜/缺口/校验/只读）
```
