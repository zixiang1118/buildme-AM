import { test,expect } from '@playwright/test';
test('I-6 I-7 fragment登录恢复、预览、草稿和卡片发布',async({page})=>{
 const data={v:1,model:'deepseek-chat',pi:{capabilities:4,llmCalls:6,toolCalls:4,tokens:31200,seconds:48},dsh:{llmCalls:17,toolCalls:19,tokens:94600,seconds:41},dshOnly:['子 Agent','联网搜索']};
 await page.goto('/new?type=compare#'+Buffer.from(JSON.stringify(data)).toString('base64url'));await expect(page).not.toHaveURL(/#/);await expect(page.getByText('分享数据已暂存。登录后会回到发帖页，补充几句话即可发布。')).toBeVisible();
 await page.getByLabel('用户名',{exact:true}).fill('浏览器管理员');await page.getByLabel('密码',{exact:true}).fill('browser-test-password');await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page).toHaveURL(/\/new\?type=compare$/);
 await expect(page.locator('[data-share-preview]')).toContainText('94,600');await page.getByLabel('正文 · Markdown').fill('这次对比的学习记录');await page.getByRole('button',{name:'保存草稿',exact:true}).click();await expect(page).toHaveURL(/\/drafts\/\d+/);await expect(page.locator('[data-share-preview]')).toContainText('94,600');
 await page.getByRole('button',{name:'发布',exact:true}).click();await expect(page).toHaveURL(/\/p\/\d+/);await expect(page.locator('[data-share-type="compare"]')).toContainText('94,600');await page.goto('/latest');await expect(page.locator('[data-share-type="compare"]').first()).toContainText('94,600');
});
