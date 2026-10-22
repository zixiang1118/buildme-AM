import { test, expect } from '@playwright/test';
test('M-6 M-7 M-10 管理员维护词库和分类，手机管理导航可用',async({page})=>{
 await page.goto('/login');await page.getByLabel('用户名',{exact:true}).fill('浏览器管理员');await page.getByLabel('密码',{exact:true}).fill('browser-test-password');await page.getByRole('button',{name:'登录',exact:true}).click();
 await page.goto('/admin/words');await page.getByLabel('词语',{exact:true}).fill('浏览器待审测试词');await page.getByRole('button',{name:'添加屏蔽词'}).click();await expect(page.getByRole('cell',{name:'浏览器待审测试词',exact:true})).toBeVisible();
 await page.goto('/admin/catalog/categories');await page.getByLabel('名称',{exact:true}).first().fill('浏览器板块');await page.getByLabel(/^地址标识/).first().fill('browser-section');await page.getByRole('button',{name:'新增板块'}).click();await expect(page.getByRole('heading',{name:'浏览器板块'})).toBeVisible();
 await page.setViewportSize({width:390,height:844});await page.goto('/admin/logs');await expect(page.getByRole('heading',{name:'操作日志',exact:true})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
