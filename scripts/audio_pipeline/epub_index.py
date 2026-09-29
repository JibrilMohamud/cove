"""Exact EPUB CFI words using the same sanitized DOM order as the Cove reader."""
import hashlib,json,posixpath,re,unicodedata,zipfile
from urllib.parse import unquote
from xml.dom import minidom,Node
WORD=re.compile(r"[^\W_]+(?:['’\-][^\W_]+)*",re.UNICODE)
def normalize(t):return ''.join(c for c in unicodedata.normalize('NFKD',t).casefold() if c.isalnum())
def children(n,kind=Node.ELEMENT_NODE):return [x for x in n.childNodes if x.nodeType==kind]
def cfi(node,offset,base):
    steps=[];current=node
    while current.parentNode and current.parentNode.nodeType!=Node.DOCUMENT_NODE:
        kind=Node.TEXT_NODE if current.nodeType==Node.TEXT_NODE else Node.ELEMENT_NODE;n=children(current.parentNode,kind).index(current)
        steps.append(str(2*n+1 if kind==Node.TEXT_NODE else 2*(n+1)));current=current.parentNode
    return 'epubcfi('+base+'!/'+('/'.join(reversed(steps)))+':'+str(offset)+')'
def utf16(text):return len(text.encode('utf-16-le'))//2
def build(path):
    words=[]
    with zipfile.ZipFile(path) as z:
        if len(z.infolist())>3000 or sum(i.file_size for i in z.infolist())>60*1024*1024:raise ValueError('EPUB exceeds reader limits')
        container=minidom.parseString(z.read('META-INF/container.xml'));opf_path=container.getElementsByTagName('rootfile')[0].getAttribute('full-path')
        opf=minidom.parseString(z.read(opf_path));spine=opf.getElementsByTagName('spine')[0];step=2*(children(spine.parentNode).index(spine)+1);items={n.getAttribute('id'):n for n in opf.getElementsByTagName('item')}
        for i,ref in enumerate(spine.getElementsByTagName('itemref')):
            item=items[ref.getAttribute('idref')]
            if ref.getAttribute('linear')=='no' or 'nav' in item.getAttribute('properties').split():continue
            href=unquote(posixpath.normpath(posixpath.join(posixpath.dirname(opf_path),item.getAttribute('href'))))
            if href.startswith('../'):raise ValueError('Invalid EPUB path')
            doc=minidom.parseString(z.read(href))
            for n in list(doc.getElementsByTagName('*')):
                if n.localName in {'script','iframe','frame','object','embed','form','input','button','textarea','base'} or(n.localName=='meta' and n.hasAttribute('http-equiv')):n.parentNode.removeChild(n)
            doc.normalize();bodies=doc.getElementsByTagName('body')
            if not bodies:continue
            base=f'/{step}/{2*(i+1)}'
            def visit(node):
                if node.nodeType==Node.ELEMENT_NODE and(node.localName in {'head','nav','style'} or node.getAttribute('aria-hidden')=='true'):return
                if node.nodeType==Node.TEXT_NODE:
                    for m in WORD.finditer(node.data):
                        token=normalize(m[0])
                        if token:words.append({'text':m[0],'norm':token,'cfi':cfi(node,utf16(node.data[:m.start()]),base),'endCfi':cfi(node,utf16(node.data[:m.end()]),base),'href':href})
                else:
                    for child in node.childNodes:visit(child)
            visit(bodies[0])
    return {'version':1,'epubSha256':hashlib.sha256(open(path,'rb').read()).hexdigest(),'words':words}
