# Galileo Open API 端点参考（asterfire CLI 后端）

Base: `https://sidereus-ai.com/api/open/v1`  ·  认证头: `Asterfire-Token: <token>`  ·  统一响应 `{success, data}`


## `GET /info`
Get Info  

## `GET /health`
Get Health  

## `GET /workflows`
List Workflows  
**参数**
- `workspace_id` (query, 可选) integer|null — 团队 ID
- `folder_id` (query, 可选) integer|null — 目录 ID
- `status` (query, 可选) string|null — 按状态筛选

## `POST /workflows`
Create Workflow  
**请求体** `application/json` （必填）
  - `title` : string
  - `prompt` : string
  - `file_ids` : array<string>
  - `workspace_id` : integer|null

## `GET /workflows/{plan_id}`
Get Workflow  
**参数**
- `plan_id` (path, 必填) integer

## `PATCH /workflows/{plan_id}`
Update Workflow  
**参数**
- `plan_id` (path, 必填) integer
**请求体** `application/json` （必填）
  - `title` : string|null
  - `folder_id` : integer|null

## `DELETE /workflows/{plan_id}`
Delete Workflow  
**参数**
- `plan_id` (path, 必填) integer

## `POST /workflows/{plan_id}/execute`
Execute Workflow  
**参数**
- `plan_id` (path, 必填) integer
- `no_cache` (query, 可选) boolean — 跳过缓存复用历史产出
**请求体** `application/json` （必填）
  - `inherit_inputs_from` : integer|null
  - `use_default_inputs` : boolean

## `GET /workflows/{plan_id}/status`
Get Workflow Status  
**参数**
- `plan_id` (path, 必填) integer
- `execution_id` (query, 可选) integer|null

## `POST /workflows/{plan_id}/cancel`
Cancel Workflow  
**参数**
- `plan_id` (path, 必填) integer

## `GET /workflows/{plan_id}/executions`
List Workflow Executions  
**参数**
- `plan_id` (path, 必填) integer

## `GET /workflows/{plan_id}/executions/{execution_id}`
Get Workflow Execution  
**参数**
- `plan_id` (path, 必填) integer
- `execution_id` (path, 必填) integer

## `DELETE /workflows/{plan_id}/executions/{execution_id}`
Delete Workflow Execution  
**参数**
- `plan_id` (path, 必填) integer
- `execution_id` (path, 必填) integer

## `GET /workflows/{plan_id}/executions/{execution_id}/status`
Get Workflow Execution Status  
**参数**
- `plan_id` (path, 必填) integer
- `execution_id` (path, 必填) integer

## `GET /workflows/{plan_id}/executions/{execution_id}/lineage`
Get Workflow Execution Lineage  
**参数**
- `plan_id` (path, 必填) integer
- `execution_id` (path, 必填) integer

## `PATCH /workflows/{plan_id}/plan`
Update Workflow Plan  
**参数**
- `plan_id` (path, 必填) integer
**请求体** `application/json` （必填）
  - `{"type": "object", "additionalProperties": true, "title": "Body"}`

## `POST /workflows/{plan_id}/patch`
Patch Workflow  
**参数**
- `plan_id` (path, 必填) integer
**请求体** `application/json` （必填）
  - `{"anyOf": [{"type": "object", "additionalProperties": true}, {"type": "array", "items": {}}], "title": "Body"}`

## `POST /workflows/{plan_id}/validate`
Validate Workflow  
**参数**
- `plan_id` (path, 必填) integer

## `GET /workflows/{plan_id}/export`
Export Workflow  
**参数**
- `plan_id` (path, 必填) integer

## `POST /workflows/import`
Import Workflow Yaml  
**请求体** `application/json` （必填）
  - `{"additionalProperties": true, "type": "object", "title": "Body"}`

## `PUT /workflows/{plan_id}/yaml`
Replace Workflow Yaml  
**参数**
- `plan_id` (path, 必填) integer
**请求体** `application/json` （必填）
  - `{"type": "object", "additionalProperties": true, "title": "Body"}`

## `POST /workflows/{plan_id}/yaml/validate`
Validate Workflow Yaml  
**参数**
- `plan_id` (path, 必填) integer
**请求体** `application/json` （必填）
  - `{"type": "object", "additionalProperties": true, "title": "Body"}`

## `PUT /workflows/{plan_id}/demos`
Update Workflow Demos  
**参数**
- `plan_id` (path, 必填) integer
**请求体** `application/json` （必填）
  - `{"type": "object", "additionalProperties": true, "title": "Body"}`

## `PATCH /workflows/{plan_id}/nodes/{node_id}/config`
Update Workflow Node Config  
**参数**
- `plan_id` (path, 必填) integer
- `node_id` (path, 必填) string
**请求体** `application/json` （必填）
  - `{"type": "object", "additionalProperties": true, "title": "Body"}`

## `GET /workflows/{plan_id}/nodes/{node_id}/outputs`
Get Workflow Node Outputs  
**参数**
- `plan_id` (path, 必填) integer
- `node_id` (path, 必填) string
- `execution_id` (query, 必填) integer

## `GET /workflows/{plan_id}/nodes/{node_id}/execution`
Get Workflow Node Execution  
**参数**
- `plan_id` (path, 必填) integer
- `node_id` (path, 必填) string
- `execution_id` (query, 必填) integer

## `GET /workflows/{plan_id}/nodes/{node_id}/steps/{step_id}/logs`
Get Workflow Node Step Logs  
**参数**
- `plan_id` (path, 必填) integer
- `node_id` (path, 必填) string
- `step_id` (path, 必填) integer
- `execution_id` (query, 必填) integer

## `POST /workflows/{plan_id}/nodes/{node_id}/retry`
Retry Workflow Node  
**参数**
- `plan_id` (path, 必填) integer
- `node_id` (path, 必填) string

## `POST /workflows/{plan_id}/nodes/{node_id}/steps/{step_id}/retry`
Retry Workflow Step  
**参数**
- `plan_id` (path, 必填) integer
- `node_id` (path, 必填) string
- `step_id` (path, 必填) integer
- `execution_id` (query, 必填) integer
**请求体** `application/json` （可选）
  - `{"type": "object", "additionalProperties": true, "default": {}, "title": "Body"}`

## `POST /workflows/{plan_id}/nodes/{node_id}/stop`
Stop Workflow Node  
**参数**
- `plan_id` (path, 必填) integer
- `node_id` (path, 必填) string
- `execution_id` (query, 必填) integer

## `POST /workflows/{plan_id}/nodes/{node_id}/input`
Submit Workflow Node Input  
**参数**
- `plan_id` (path, 必填) integer
- `node_id` (path, 必填) string
- `execution_id` (query, 必填) integer
**请求体** `application/json` （必填）
  - `{"type": "object", "additionalProperties": true, "title": "Body"}`

## `POST /workflows/{plan_id}/nodes/{node_id}/input/file`
Submit Workflow Node Input File  
**参数**
- `plan_id` (path, 必填) integer
- `node_id` (path, 必填) string
- `execution_id` (query, 必填) integer
**请求体** `multipart/form-data` （必填）
  - `file`* : string — 节点输入文件

## `GET /workflow-tools`
List Workflow Tools  
**参数**
- `category` (query, 可选) string|null
- `type` (query, 可选) string|null
- `query` (query, 可选) string|null
- `dag_only` (query, 可选) boolean

## `GET /workflow-tools/{name}/contract`
Get Workflow Tool Contract  
**参数**
- `name` (path, 必填) string

## `GET /workflow-tools/{name}/detail`
Get Workflow Tool Detail  
**参数**
- `name` (path, 必填) string

## `GET /workflow-templates`
List Workflow Templates  
**参数**
- `scope` (query, 可选) string|null
- `query` (query, 可选) string|null
- `category` (query, 可选) string|null

## `GET /workflow-templates/{template_id}`
Get Workflow Template  
**参数**
- `template_id` (path, 必填) integer

## `DELETE /workflow-templates/{template_id}`
Delete Workflow Template  
**参数**
- `template_id` (path, 必填) integer

## `POST /workflow-templates/{template_id}/create-workflow`
Create Workflow From Template  
**参数**
- `template_id` (path, 必填) integer
**请求体** `application/json` （可选）
  - `{"type": "object", "additionalProperties": true, "default": {}, "title": "Body"}`

## `POST /workflows/{plan_id}/template`
Save Workflow Template  
**参数**
- `plan_id` (path, 必填) integer
**请求体** `application/json` （必填）
  - `{"type": "object", "additionalProperties": true, "title": "Body"}`

## `POST /files/upload`
Upload Task File  
**请求体** `multipart/form-data` （必填）
  - `file`* : string — 要上传的文件
  - `task_id` : string|null — 关联的任务 ID（可选）

## `GET /cloud-disk/files`
List Cloud Disk Files  
**参数**
- `workspace_id` (query, 可选) integer|null — 团队 ID
- `parent_id` (query, 可选) integer|null — 父目录 ID
- `page` (query, 可选) integer|null — 页码，从 1 开始；不传则返回全部
- `per_page` (query, 可选) integer — 每页条数
- `q` (query, 可选) string|null — 按文件名搜索

## `POST /cloud-disk/files`
Upload Cloud Disk File  
**请求体** `multipart/form-data` （必填）
  - `file`* : string — 要上传的文件
  - `workspace_id` : integer|null — 目标团队 ID（可选）
  - `parent_id` : integer|null — 目标父目录 ID（可选）

## `GET /tasks/files`
List Task Files  
**参数**
- `path` (query, 必填) string — 任务目录路径（base64 编码或纯数字 ID）
- `workspace_id` (query, 可选) integer|null — 团队 ID

## `GET /files/{file_id}/download`
Download File  
**参数**
- `file_id` (path, 必填) string
- `workspace_id` (query, 可选) integer|null — 团队 ID

## `POST /cloud-disk/uploads`
Init Chunked Upload  
**请求体** `application/json` （必填）
  - `file_name`* : string
  - `file_size`* : integer
  - `file_hash` : string|null
  - `chunk_size` : integer|null
  - `workspace_id` : integer|null
  - `parent_id` : integer|null

## `GET /cloud-disk/uploads/{session_id}`
Get Chunked Upload Status  
**参数**
- `session_id` (path, 必填) string

## `POST /cloud-disk/uploads/{session_id}/chunks`
Upload Chunk  
**参数**
- `session_id` (path, 必填) string
**请求体** `multipart/form-data` （必填）
  - `chunk`* : string — 分片二进制内容
  - `chunk_index`* : integer — 分片序号，从 0 开始
  - `chunk_hash` : string|null — 分片 SHA256，可选校验

## `POST /cloud-disk/uploads/{session_id}/complete`
Complete Chunked Upload  
**参数**
- `session_id` (path, 必填) string
**请求体** `application/json` （必填）
  - `file_hash` : string|null
  - `workspace_id` : integer|null
  - `parent_id` : integer|null

## `GET /models`
List Models  

## `GET /tasks`
List Tasks  
**参数**
- `type` (query, 可选) string|null — 按任务类型筛选
- `workspace_id` (query, 可选) integer|null — 团队 ID
- `page` (query, 可选) integer|null — 页码
- `per_page` (query, 可选) integer|null — 每页条数（上限 100）
- `keyword` (query, 可选) string|null — 按标题搜索
- `folder_id` (query, 可选) integer|null — 目录 ID

## `POST /tasks`
Create Task  
**请求体** `application/json` （必填）
  - `message`* : string
  - `toolbox`* : string
  - `file_ids` : array<?>
  - `workspace_id` : integer|null
  - `llm_model` : string|null
  - `folder_id` : integer|null

## `GET /tasks/{task_id}`
Get Task  
**参数**
- `task_id` (path, 必填) integer
- `limit` (query, 可选) integer|null — 返回的消息条数上限

## `DELETE /tasks/{task_id}`
Delete Task  
**参数**
- `task_id` (path, 必填) integer

## `GET /tasks/{task_id}/status`
Get Task Status  
**参数**
- `task_id` (path, 必填) integer
- `step_id` (query, 可选) integer|null — 指定 step，为空时取任务级状态

## `POST /tasks/{task_id}/messages`
Send Task Message  
**参数**
- `task_id` (path, 必填) integer
**请求体** `application/json` （必填）
  - `message`* : string
  - `file_ids` : array<?>
  - `llm_model` : string|null

## `POST /tasks/{task_id}/stop`
Stop Task  
**参数**
- `task_id` (path, 必填) integer

## `POST /tasks/{task_id}/rename`
Rename Task  
**参数**
- `task_id` (path, 必填) integer
**请求体** `application/json` （必填）
  - `name`* : string
  - `workspace_id` : integer|null

## `GET /toolboxes`
List Toolboxes  
**参数**
- `type` (query, 可选) string — 工具箱类型（agent 或 kit）

## `POST /kits/submit`
Submit Kit  
**请求体** `application/json` （必填）
  - `toolbox`* : string
  - `input`* : object
  - `workspace_id` : integer|null

## `POST /tasks/{task_id}/kit-run`
Run Kit  
**参数**
- `task_id` (path, 必填) integer
**请求体** `application/json` （必填）
  - `kit_name`* : string
  - `input`* : object

## `GET /dev/images`
List Dev Images  
**参数**
- `page` (query, 可选) integer — 页码
- `per_page` (query, 可选) integer — 每页条数
- `name` (query, 可选) string|null — 按名称筛选
- `version` (query, 可选) string|null — 按版本筛选

## `POST /dev/images`
Create Dev Image  
**请求体** `application/json` （必填）
  - `name`* : string
  - `version`* : string
  - `remark` : string
  - `file_id` : string|integer|null
  - `docker_url` : string|null
  - `docker_username` : string|null
  - `docker_password` : string|null
  - `source_type` : string

## `GET /dev/images/build-clusters`
List Dev Image Build Clusters  
**参数**
- `sif_id` (query, 可选) integer|null — 沿用该 SIF 上次构建集群作为默认项

## `GET /dev/images/{image_id}`
Get Dev Image  
**参数**
- `image_id` (path, 必填) integer

## `PUT /dev/images/{image_id}`
Update Dev Image  
**参数**
- `image_id` (path, 必填) integer
**请求体** `application/json` （必填）
  - `name` : string|null
  - `version` : string|null
  - `remark` : string|null
  - `is_working` : boolean|null
  - `cuda_version` : string|null
  - `bind_paths` : array<string>|null
  - `docker_image` : string|null
  - `docker_url` : string|null
  - `docker_username` : string|null
  - `docker_password` : string|null
  - `source_type` : string|null

## `DELETE /dev/images/{image_id}`
Delete Dev Image  
**参数**
- `image_id` (path, 必填) integer

## `POST /dev/images/{image_id}/build`
Build Dev Image  
**参数**
- `image_id` (path, 必填) integer
**请求体** `application/json` （必填）
  - `target_cluster_codes`* : array<string>
  - `file_id` : string|integer|null

## `GET /dev/async-tasks/{task_id}`
Get Dev Async Task  
**参数**
- `task_id` (path, 必填) integer
- `limit` (query, 可选) integer|null — 消息条数上限

## `GET /dev/async-tasks/{task_id}/log`
Get Dev Async Task Log  
**参数**
- `task_id` (path, 必填) integer
- `step_id` (query, 必填) integer — step ID
- `stream` (query, 可选) string — 日志流：stdout 或 stderr

## `POST /dev/toolboxes/inspect`
Inspect Dev Toolbox  
**请求体** `multipart/form-data` （可选）
  - `file` : string|null

## `GET /dev/toolboxes/inspection`
Get Dev Toolbox Inspection  
**参数**
- `name` (query, 必填) string
- `version` (query, 必填) string

## `GET /dev/toolboxes`
List Dev Toolboxes  

## `POST /dev/toolboxes`
Upload Dev Toolbox  
**请求体** `multipart/form-data` （可选）
  - `file` : string|null — 工具箱压缩包
  - `force` : boolean — 是否强制覆盖同名版本
  - `skip_llm_review` : boolean — 保留兼容参数；当前始终执行静态检测