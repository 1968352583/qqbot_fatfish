# 百炼账户余额与额度接入调查

核实日期：2026-11-17。项目使用北京地域、工作空间 API Key 和 `qwen-audio-3.1-tts-plus`。本次只查公开官方资料及本机 CLI 元数据，未读取账号余额或实际额度。

## 结论与边界

项目记录的语音费用是本项目调用的核算；阿里云现金余额、模型免费额度、资源包余量属于三套不同数据，不能彼此替代或直接相加。现有 `sk-ws` Key 不能作为费用中心或 CLI 控制台令牌使用。

| 数据 | 官方入口 | 鉴权与范围 |
| --- | --- | --- |
| 阿里云账户现金余额 | BssOpenApi / 2017-12-14 / QueryAccountBalance | 云 AK/SK 或 STS 签名；RAM `bss:DescribeAcccount`，Resource `*`；账户级 |
| 有效资源包余量 | BssOpenApi / 2017-12-14 / QueryResourcePackageInstances | 云 AK/SK 或 STS 签名；RAM `bss:DescribeInstances`，Resource `*`；账户级 |
| 指定模型免费额度 | `bl usage free --model qwen-audio-3.1-tts-plus --output json` | CLI console token；独立于模型 API Key；模型和地域相关 |

## 现金余额

中国站费用中心 endpoint 是 `https://business.aliyuncs.com/`，与模型部署的北京地域区分。QueryAccountBalance 无业务请求参数。必须验证响应 `Success`，不能只看 HTTP 200。只显示 `Data.AvailableCashAmount`（现金）、`AvailableAmount`（可用额度）、`Currency`；`QuotaLimit` 是生态客户限额，不是模型免费额度。[官方 API](https://help.aliyun.com/zh/user-center/developer-reference/api-bssopenapi-2017-12-14-queryaccountbalance)、[endpoint 说明](https://help.aliyun.com/en/user-center/developer-reference/common-probleam)。

最小已核实 RAM 策略（仅现金与资源包）：

```json
{"Version":"1","Statement":[{"Effect":"Allow","Action":["bss:DescribeAcccount","bss:DescribeInstances"],"Resource":"*"}]}
```

`DescribeAcccount` 的三个连续 c 是官方拼写。请求使用 RPC HMAC-SHA1、SignatureVersion 1.0、UTC Timestamp、独立随机 SignatureNonce；STS 的 SecurityToken 必须参与签名。[公共参数](https://help.aliyun.com/en/user-center/developer-reference/common-parameters)、[费用中心签名](https://help.aliyun.com/zh/user-center/developer-reference/signature)。

## 资源包

当前 API 说明仅查询有效资源包；使用 PageNum / PageSize 分页。列表路径是 `Data.Instances.Instance`，字段包括 `RemainingAmount`、`RemainingAmountUnit`、`TotalAmount`、`TotalAmountUnit`、`ExpiryTime`、`Status`、`CommodityCode`、`PackageType`、`ApplicableProducts.Product`、`Region`。完整成功且列表为空才能称为没有返回有效资源包；权限失败、字段缺失、分页截断不能转成零。[官方 API 和授权表](https://help.aliyun.com/zh/user-center/developer-reference/api-bssopenapi-2017-12-14-queryresourcepackageinstances)。

尚未核实 qwen-audio-3.1-tts-plus 对应的资源包产品代码与适用关系。官网另有语音节省计划，它与资源包不是同一对象。因此初版应标明“阿里云账户有效资源包”，保留服务代码与单位供管理员核对，不把所有包求和或自动宣称可抵扣本模型。BSS 资源包查询不等于已接入节省计划余量。[节省计划与资源包](https://help.aliyun.com/zh/model-studio/savings-plan-and-resource-package)。

## 免费额度：有官方查询能力，尚需单独授权

官方命令文档以 **bl 2.8.0** 为基准。查询需要 `auth: console`，不是模型 Key。`usage freetier` 会修改用完即停设置，不能拿它作查询。[命令文档](https://help.aliyun.com/zh/model-studio/cli/usage-quota)、[官方实现](https://github.com/modelstudioai/cli/blob/98ceadc00e00bd5043f266ba3781268e6b83b12f/packages/commands/src/commands/usage/free.ts)。

官方底层接口 `zeldaEasy.bailian-commerce.freeTrial.queryFreeTierQuota` 的业务参数为 `queryFreeTierQuotaRequest: {models:[模型]}`。字段为 `model`、`quotaInitTotal`（总量）、`quotaTotal`（余量）、`quotaValidityPeriod`（毫秒时间戳）、`quotaStatus`。CLI 转换为 `remaining`、`total`、`expires`、百分比与 `autoStop`。没有额度记录、null、UNKNOWN、过期均不能显示为有效余量 0；只有成功返回有效数值 0 才表示耗尽。该接口类型没有单位字段，不能把所有模型统一标为 Token 或字符。[响应类型与解析](https://github.com/modelstudioai/cli/blob/98ceadc00e00bd5043f266ba3781268e6b83b12f/packages/commands/src/commands/usage/shared.ts)。

北京控制台网关为 `https://bailian-cs.console.aliyun.com/cli/api.json`，action=BroadScopeAspnGateway、product=sfm_bailian，认证为 Bearer **CLI console token**，不是 sk-ws。推荐适配固定版本官方 CLI，避免自行依赖网关内部响应结构。[官方网关实现](https://github.com/modelstudioai/cli/blob/98ceadc00e00bd5043f266ba3781268e6b83b12f/packages/core/src/console/gateway.ts)。

`bl auth login --console` 可浏览器授权，远程环境支持 `--no-browser` 或 `--token-stdin`。仅有 console token 的模式会到期；不能承诺无本机依赖的长期自动刷新。官方 CLI 在 token 缺失/过期时用 AK/SK（可带 STS）换取新 token；没有云凭据时不能自行续期。[安装与鉴权](https://help.aliyun.com/zh/model-studio/cli/installation)、[刷新实现](https://github.com/modelstudioai/cli/blob/98ceadc00e00bd5043f266ba3781268e6b83b12f/packages/core/src/auth/refresh-token.ts)。

换取令牌的公开官方实现：ModelStudio / **2026-02-10** / **GenerateCLIAccessToken**，POST `https://modelstudio.cn-beijing.aliyuncs.com/modelstudio/cli/generateAccessToken`，响应 `cliAccessToken`；它不是 BSS 权限涵盖的动作。该 action/version 也列在官方 RAM 保护清单。**尚未找到能核实该 action 与免费额度查询所需最小 RAM action 的公开授权表；不能编造精确策略，不能为此默认授予 FullAccess。**[官方 RAM 清单](https://help.aliyun.com/zh/ram/user-guide/accesskey-restrictive-protection-description)、[百炼权限说明](https://help.aliyun.com/en/model-studio/bailian-ram-permission)。

免费额度依模型、地域、有效期而定，主账号与 RAM 账号共享，控制台分钟级更新；本次未查询该账户，不能承诺本模型有赠送额度。[免费额度规则](https://help.aliyun.com/zh/model-studio/new-free-quota)。

## 实施建议与当前环境

1. 首先提供 BSS 现金与资源包查询，专用受限 RAM 凭据经后台隐藏输入或向导配置，服务器查询并缓存 5 分钟。优先考虑可续期的 ECS RAM 角色/STS；手动填入的 STS 自身会到期。模型 Key 保持独立。
2. 免费额度初版明确显示“尚未接入控制台授权”，提供官方页面链接，不能写“官方不支持”。后续在服务器固定安装 CLI、隔离 profile，再接入可续期云凭据；纯浏览器 token 模式显示到期需重新授权。
3. 每部分独立返回 not_configured / forbidden / error / ready；保留最后成功时间，短期旧值明确 stale。凭据切换清缓存；不把网络错误、无权或空字段转成零。只回传金额、币种、产品、单位、期限等白名单字段，不回传账号、联系人、原始错误、签名或 token。
4. 本机 `aliyun` 位于 `/Users/warma/.local/bin/aliyun`，版本 **3.5.3**；标准 `~/.aliyun/config.json` 不存在，检查的配置路径/profile 环境变量均未设置；PATH 未发现独立 `bl`。未据此推断服务器凭据状态，也未调用账号数据接口。

以上是接入能力调查，不是实际账户余额。后续需用用户提供的专用授权做只读联调，才能确认账户资格、权限、返回单位及资源包适用性。
