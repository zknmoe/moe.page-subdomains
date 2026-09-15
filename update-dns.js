import fs from 'fs';
import path from 'path';
import axios from 'axios';

async function processRecord(filePath) {
    let recordConfig;
    let subdomain;

    try {
        console.log(`[Message] Processing file: ${filePath}`);
        subdomain = path.basename(filePath, '.json');

        const fileContent = fs.readFileSync(filePath, 'utf8');

        recordConfig = JSON.parse(fileContent);
        console.log(recordConfig)
    } catch (error) {
        console.error(`[Error] Failed to read ${filePath}`);
        process.exit(1);
    }

    const CF_API_TOKEN = process.env.CF_API_TOKEN;
    const CF_ZONE_ID = process.env.CF_ZONE_ID;
    const rootDomain = 'moe.page';

    if (!CF_API_TOKEN || !CF_ZONE_ID) {
        console.error('[Error] Global Variable CF_API_TOKEN and/or CF_ZONE_ID are missing!');
        process.exit(1);
    }

    const apiUrl = `https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records`;
    const headers = {
        'Authorization': `Bearer ${CF_API_TOKEN}`,
        'Content-Type': 'application/json',
    };

    for (const [recordType, recordValues] of Object.entries(recordConfig.records)) {
        const name = `${recordConfig.domain}.${rootDomain}`;
        const proxiedTypes = ['A', 'AAAA', 'CNAME'];
        const isProxiedCapable = proxiedTypes.includes(recordType);
      
        // 1) 规范 & 去重；CNAME 只取一个
        let values = Array.isArray(recordValues) ? recordValues : [recordValues];
        if (recordType === 'CNAME') values = [values[0]];
        values = [...new Set(values.filter(v => v != null && v !== ''))];
      
        // 2) 目标记录（desired）一次性算好
        const desired = values.map(content => ({
          type: recordType,
          name,
          content,
          proxied: isProxiedCapable ? (recordConfig.proxied || false) : false,
          ttl: (isProxiedCapable && (recordConfig.proxied || false)) ? 1 : (recordConfig.ttl || 120),
        }));
      
        console.log(`[Plan] ${recordType} ${name} 目标 ${desired.map(d => d.content).join(', ') || '(空)'}`);
      
        // 3) 只发一次 GET（按 name+type）
        let existing = [];
        try {
          const getResponse = await axios.get(apiUrl, {
            headers,
            params: { name, type: recordType }
          });
          existing = getResponse.data?.result || [];
        } catch (error) {
          console.error(`[Error] 获取现有记录失败:`, error.response?.data || error.message);
          process.exit(1);
        }
      
        // 4) CNAME：单条 upsert（最多1次PUT或1次POST）
        if (recordType === 'CNAME') {
          const wanted = desired[0];            
          const ex = existing[0];               
          if (!wanted) {
            console.log(`[Skip] 无 CNAME 目标，跳过`);
            continue;
          }
          if (!ex) {
            console.log(`[Message] CNAME 不存在，Create...`);
            try {
              await axios.post(apiUrl, wanted, { headers });
              console.log(`[Success] Record ${wanted.name} created`);
            } catch (error) {
              console.error(`[Error] 创建失败:`, error.response?.data || error.message);
              process.exit(1);
            }
          } else {
            const needUpdate =
              ex.content !== wanted.content ||
              (ex.proxied ?? false) !== wanted.proxied ||
              (ex.ttl !== wanted.ttl);
      
            if (needUpdate) {
              console.log(`[Message] CNAME 已存在 (ID: ${ex.id})，Updating...`);
              try {
                await axios.put(`${apiUrl}/${ex.id}`, wanted, { headers });
                console.log(`[Success] Record ${wanted.name} successfully updated`);
              } catch (error) {
                console.error(`[Error] 更新失败:`, error.response?.data || error.message);
                process.exit(1);
              }
            } else {
              console.log(`[Skip] CNAME ${name} 已是最新 -> ${ex.content}`);
            }
          }
          continue;
        }
      
        const existByContent = new Map(existing.map(r => [r.content, r]));
      
        // 创建或更新
        for (const r of desired) {
          const hit = existByContent.get(r.content);
          if (!hit) {
            console.log(`[Message] 缺少 ${recordType} ${name} -> ${r.content}，Create...`);
            try {
              await axios.post(apiUrl, r, { headers });
              console.log(`[Success] Record ${name} created (${r.content})`);
            } catch (error) {
              console.error(`[Error] 创建失败:`, error.response?.data || error.message);
              process.exit(1);
            }
          } else {
            const needUpdate =
              (hit.proxied ?? false) !== r.proxied ||
              (hit.ttl !== r.ttl);
            if (needUpdate) {
              console.log(`[Message] 属性变化 (ID: ${hit.id})，Updating...`);
              try {
                await axios.put(`${apiUrl}/${hit.id}`, r, { headers });
                console.log(`[Success] Record ${name} updated (${r.content})`);
              } catch (error) {
                console.error(`[Error] 更新失败:`, error.response?.data || error.message);
                process.exit(1);
              }
            } else {
              console.log(`[Skip] ${recordType} ${name} -> ${r.content} 已是最新`);
            }
          }
        }
      
        // 删除多余（严格同步开关）
        if (process.env.STRICT_SYNC === '1') {
          const desiredSet = new Set(values);
          for (const ex of existing) {
            if (!desiredSet.has(ex.content)) {
              console.log(`[Message] 多余 ${recordType} ${name} -> ${ex.content}，Delete...`);
              try {
                await axios.delete(`${apiUrl}/${ex.id}`, { headers });
                console.log(`[Success] Deleted ${recordType} ${name} -> ${ex.content}`);
              } catch (error) {
                console.error(`[Error] 删除失败:`, error.response?.data || error.message);
                process.exit(1);
              }
            }
          }
        }
      }
}



const inputPath = process.argv[2];

if (!inputPath) {
    console.error('[Error] Please provide a file path as a parameter!');
    process.exit(1);
}

const recordsDir = path.resolve('records');
const filePath = path.resolve(recordsDir, path.basename(inputPath));

if (path.dirname(filePath) !== recordsDir) {
    console.error('[Error] Invalid file path!');
    process.exit(1);
}

processRecord(filePath);