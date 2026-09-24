export type Taxonomy={category:string;subcategory?:string;audience?:string;platform?:string;priceTier?:string;confidence:number};
type Rule={pattern:RegExp;category:string;subcategory?:string};
const rules:Rule[]=[
{pattern:/laptop|notebook|macbook|chromebook|ultrabook/i,category:"Computers",subcategory:"Laptops"},
{pattern:/desktop|imac|gaming pc|workstation/i,category:"Computers",subcategory:"Desktops"},
{pattern:/iphone|android phone|pixel|galaxy|smartphone|mobile phone/i,category:"Phones",subcategory:"Smartphones"},
{pattern:/ipad|android tablet|galaxy tab|tablet/i,category:"Tablets",subcategory:"Tablets"},
{pattern:/monitor|display|ultrawide|4k monitor/i,category:"Computer Accessories",subcategory:"Monitors"},
{pattern:/keyboard|mechanical keyboard|mouse|webcam|dock|hub/i,category:"Computer Accessories",subcategory:"Peripherals"},
{pattern:/headphone|headset|earbud|airpods|speaker/i,category:"Audio",subcategory:"Headphones & Earbuds"},
{pattern:/ssd|hard drive|nas|storage drive/i,category:"Storage",subcategory:"Storage"},
{pattern:/router|wifi|mesh network|networking/i,category:"Networking",subcategory:"Wi-Fi & Networking"},
{pattern:/camera|mirrorless|dslr|action camera/i,category:"Cameras",subcategory:"Cameras"},
{pattern:/smartwatch|wearable|fitness tracker|apple watch|galaxy watch/i,category:"Wearables",subcategory:"Smartwatches & Trackers"},
{pattern:/tv|television|oled|qled|mini-led/i,category:"TV & Home Theater",subcategory:"Televisions"},
{pattern:/github|gitlab|docker|kubernetes|ide|developer tool|api|sdk/i,category:"Developer Software",subcategory:"Developer Tools"},
{pattern:/chatgpt|claude|gemini|copilot|ai tool|artificial intelligence/i,category:"AI Tools",subcategory:"AI Assistants"},
{pattern:/password manager|vpn|antivirus|endpoint security|security software/i,category:"Security Software",subcategory:"Security & Privacy"},
{pattern:/project management|crm|helpdesk|accounting software|business software/i,category:"Business Software",subcategory:"Business Tools"}];
const platformRules:[RegExp,string][]=[[/windows 11|windows 10|windows/i,"Windows"],[/macos|mac os|os x/i,"macOS"],[/chromeos|chromebook/i,"ChromeOS"],[/ios|iphone/i,"iOS"],[/android/i,"Android"],[/linux|ubuntu|fedora|debian/i,"Linux"],[/web app|browser-based|saas/i,"Web"]];
const audienceRules:[RegExp,string][]=[[/gaming|gamer|esports/i,"Gaming"],[/student|college|university/i,"Students"],[/creator|content creator|video editing|photographer/i,"Creators"],[/developer|programmer|software engineer/i,"Developers"],[/business|enterprise|office|professional/i,"Business & Professionals"],[/family|parent|kids/i,"Families"]];
const priceRules:[RegExp,string][]=[[/under\s*\$?\s*100|budget|affordable|entry[- ]level/i,"Budget"],[/premium|flagship|high[- ]end|luxury/i,"Premium"],[/mid[- ]range|\$\s*[3-9]00/i,"Mid-range"]];
export function categorize(text:string):Taxonomy{const hit=rules.find(r=>r.pattern.test(text));const platform=platformRules.find(([p])=>p.test(text))?.[1];const audience=audienceRules.find(([p])=>p.test(text))?.[1];const priceTier=priceRules.find(([p])=>p.test(text))?.[1];return{category:hit?.category||"Technology",subcategory:hit?.subcategory,audience,platform,priceTier,confidence:hit?0.92:0.55};}
