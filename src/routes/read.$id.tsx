import {createFileRoute} from "@tanstack/react-router";
import {ReaderPage} from "@/features/fore/Reader";
export const Route=createFileRoute("/read/$id")({component:Page});
function Page(){const {id}=Route.useParams();return <ReaderPage id={id}/>}
