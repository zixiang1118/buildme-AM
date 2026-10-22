import { expect,it } from 'vitest';
import { fixture,browser } from './helpers.js';
import { parseShare } from '../src/lib/share.js';
const compare={v:1,type:'compare',model:'deepseek-chat',pi:{capabilities:4,llmCalls:6,toolCalls:4,tokens:31200,seconds:48},dsh:{llmCalls:17,toolCalls:19,tokens:94600,seconds:41},dshOnly:['子 Agent','联网搜索']};
it('I-6 分享数据发布、信息流和详情卡片、编辑与服务器草稿保持',async()=>{
 const f=await fixture(),b=browser(f.app);await b.login();await b.request('/new');const values={title:'同一个任务的真实对比',category:'1',body:'学习记录',shareData:JSON.stringify(compare)};
 expect((await b.post('/drafts',values)).status).toBe(303);expect(await(await b.request('/drafts/1')).text()).toContain('shareData');expect((await b.post('/new',values)).status).toBe(303);
 for(const url of ['/p/1','/latest']){const html=await(await b.request(url)).text();expect(html).toContain('data-share-type="compare"');expect(html).toContain('94,600');expect(html).not.toContain('已验证');}
 expect(await(await b.request('/p/1/edit')).text()).toContain('94600');await f.close();
});
it('I-8 拒绝负数、非数值、超限字符和未知字段，成就范围严格校验',()=>{
 expect(parseShare(JSON.stringify(compare))).toEqual(compare);
 for(const patch of [{model:'字'.repeat(81)},{pi:{...compare.pi,tokens:-1}},{dsh:{...compare.dsh,seconds:1e9}},{dshOnly:Array(9).fill('工具')},{dshOnly:['字'.repeat(13)]},{prompt:'private'}])expect(()=>parseShare(JSON.stringify({...compare,...patch}))).toThrow('分享数据无效');
 const achievement={v:1,type:'achievement',id:'parallel-tools',name:'左右开弓',unlocked:11,total:30};expect(parseShare(JSON.stringify(achievement))).toEqual(achievement);expect(()=>parseShare(JSON.stringify({...achievement,unlocked:31}))).toThrow();
});
it('I-8 非法分享经发布与存草稿接口拒绝',async()=>{const f=await fixture(),b=browser(f.app);await b.login();await b.request('/new');for(const path of ['/new','/drafts'])expect((await b.post(path,{title:'非法统计数据测试',category:'1',shareData:JSON.stringify({...compare,pi:{...compare.pi,tokens:-3}})})).status).toBe(422);expect(f.db.prepare('SELECT COUNT(*) n FROM posts').get()).toEqual({n:0});await f.close();});
