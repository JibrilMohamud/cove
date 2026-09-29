import { createFileRoute, redirect } from "@tanstack/react-router";
export const Route = createFileRoute("/store")({
  beforeLoad:()=>{throw redirect({to:"/",replace:true,statusCode:308});},
  component:()=>null,
});
