import {expect,it,vi} from 'vitest'
import {runHeadlessLoop} from '../../src/lib/simulate/headless-loop.js'
import type {McpClient} from '../../src/lib/mcp/client.js'
it('cancels a waiting model call and never dispatches a late tool request',async()=>{
  const controller=new AbortController(),callTool=vi.fn()
  let finish!:(value:{content:null;toolCalls:{id:string;name:string;arguments:Record<string,unknown>}[]})=>void
  const pending=new Promise<{content:null;toolCalls:{id:string;name:string;arguments:Record<string,unknown>}[]}>(resolve=>{finish=resolve})
  const promise=runHeadlessLoop({signal:controller.signal,provider:{sendInitial:()=>pending,sendToolResults:vi.fn()},mcpClient:{callTool} as unknown as McpClient,tools:[],message:'hello'})
  controller.abort()
  await expect(promise).rejects.toMatchObject({category:'cancelled'})
  finish({content:null,toolCalls:[{id:'late',name:'should-not-run',arguments:{}}]})
  await Promise.resolve()
  expect(callTool).not.toHaveBeenCalled()
})
it('retains completed tool observations if the following model call is cancelled',async()=>{
  const controller=new AbortController(),captured:unknown[]=[]
  let entered!:()=>void
  const reached=new Promise<void>(resolve=>{entered=resolve})
  const promise=runHeadlessLoop({signal:controller.signal,onTrace:trace=>captured.push(trace),provider:{sendInitial:async()=>({content:null,toolCalls:[{id:'one',name:'fixture',arguments:{}}]}),sendToolResults:()=>{entered();return new Promise(()=>{})}},mcpClient:{callTool:async()=>({content:[{type:'text',text:'completed'}]})} as unknown as McpClient,tools:[{name:'fixture',inputSchema:{type:'object'}}],message:'hello'})
  await reached;controller.abort()
  await expect(promise).rejects.toMatchObject({category:'cancelled'})
  expect(captured).toMatchObject([[{toolName:'fixture',status:'success'}]])
})
